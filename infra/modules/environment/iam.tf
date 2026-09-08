# ECS task execution role (pulls images, reads the app secret, writes logs) and an
# optional task role (what the running containers may call). Secrets access is scoped
# to this environment's own secret rather than the AWS-managed SecretsManagerReadWrite.
# Without a task role, `aws ecs execute-command` does not work — create one.
resource "aws_iam_role" "execution" {
  name = var.execution_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowAccessToECSForTaskExecutionRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets_scoped" {
  name = "${var.name_prefix}-secrets-read"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadAppSecret"
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = "${aws_secretsmanager_secret.app.arn}*"
    }]
  })
}

# Optional task role (uat): empty for now — its existence enables ECS Exec /
# future AWS API access without a task-def surgery later, closing production's
# no-taskRoleArn gap greenfield.
resource "aws_iam_role" "task" {
  count = var.create_task_role ? 1 : 0
  name  = "${var.name_prefix}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = local.common_tags
}
