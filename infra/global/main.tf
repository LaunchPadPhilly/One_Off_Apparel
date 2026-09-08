# Account-level, environment-independent resources: the two ECR repositories both
# environments pull from, and the single IAM role GitHub Actions assumes via OIDC.
#
# The GitHub OIDC *provider* is deliberately NOT managed here. It is account-shared
# (one per AWS account, used by every project) and is referenced by ARN only. Create it
# once per account before the first apply:
#   aws iam create-open-id-connect-provider \
#     --url https://token.actions.githubusercontent.com \
#     --client-id-list sts.amazonaws.com \
#     --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1

data "aws_caller_identity" "current" {}

locals {
  account_id               = data.aws_caller_identity.current.account_id
  github_oidc_provider_arn = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"

  # Standard form `repo:ORG/REPO`; overridable for repositories whose OIDC customization
  # emits the id-annotated form — see variables.tf.
  github_repo_sub_prefix = coalesce(
    var.github_oidc_subject_prefix != "" ? var.github_oidc_subject_prefix : null,
    "repo:${var.github_org}/${var.github_repo}"
  )

  github_subs = [for env in var.github_environments : "${local.github_repo_sub_prefix}:environment:${env}"]

  # Roles the deploy role may hand to ECS tasks. Each environment root creates
  # `<name_prefix>-task-execution-role` and `<name_prefix>-task` (see modules/environment/iam.tf).
  passable_role_arns = flatten([
    for prefix in var.environment_name_prefixes : [
      "arn:aws:iam::${local.account_id}:role/${prefix}-task-execution-role",
      "arn:aws:iam::${local.account_id}:role/${prefix}-task",
    ]
  ])
}

# ------------------------------------------------------------------ ECR repos
resource "aws_ecr_repository" "web" {
  name                 = "${var.name_prefix}-web"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_repository" "mcp" {
  name                 = "${var.name_prefix}-mcp"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy     = local.ecr_keep_policy
}

resource "aws_ecr_lifecycle_policy" "mcp" {
  repository = aws_ecr_repository.mcp.name
  policy     = local.ecr_keep_policy
}

locals {
  ecr_keep_policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the most recent ${var.ecr_keep_last} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_keep_last
      }
      action = { type = "expire" }
    }]
  })
}

# ------------------------------------------------- GitHub Actions deploy role
resource "aws_iam_role" "github_deploy" {
  name                 = "${var.name_prefix}-github-deploy"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = local.github_oidc_provider_arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = local.github_subs
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "${var.name_prefix}-github-deployPolicy"
  role = aws_iam_role.github_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "ECRPushToProjectRepos"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:DescribeImages",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
        ]
        Resource = [
          aws_ecr_repository.web.arn,
          aws_ecr_repository.mcp.arn,
        ]
      },
      {
        # Task-definition registration and service updates cannot be scoped tighter than
        # the account: RegisterTaskDefinition supports no resource ARN.
        Sid    = "ECSDeploy"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:RunTask",
          "ecs:DescribeTasks",
        ]
        Resource = "*"
      },
      {
        Sid      = "PassTaskRoles"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = local.passable_role_arns
      },
    ]
  })
}
