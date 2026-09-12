variable "aws_region" {
  description = "Region for ECR and the deploy role. Must match the environments' region."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for every account-level resource this root creates (ECR repos, deploy role). Usually the project slug."
  type        = string
  default     = "ooa"
}

variable "github_org" {
  description = "GitHub organization (or user) that owns the repository running the deploy workflows."
  type        = string
  default     = "LaunchPadPhilly"
}

variable "github_repo" {
  description = "Repository name (without the org) running the deploy workflows."
  type        = string
  default     = "One_Off_Apparel"
}

variable "github_environments" {
  description = <<-EOT
    GitHub Actions environment names allowed to assume the deploy role. Load-bearing: the
    trust policy matches `environment:<name>` in the OIDC token subject, so a workflow job
    that declares none of these cannot obtain AWS credentials at all. Must match the
    `environment:` keys in .github/workflows/*.yml.
  EOT
  type        = list(string)
  default     = ["UAT", "Production"]
}

variable "github_oidc_subject_prefix" {
  description = <<-EOT
    Override for the OIDC subject prefix, without the trailing `environment:` part. Leave
    empty to use the standard `repo:<org>/<repo>`. Set it only if the repository's OIDC
    customization emits the id-annotated form — check with
    `gh api repos/<org>/<repo>/actions/oidc/customization/sub`; if `sub_claim_prefix` is
    returned, that value goes here verbatim. A repository transfer between owners changes
    this value and silently breaks every deploy until it is updated.
  EOT
  type        = string
  default     = ""
}

variable "environment_name_prefixes" {
  description = <<-EOT
    The `name_prefix` of every environment root (e.g. ["ooa-uat", "ooa"]).
    Used to scope which task-execution and task roles the deploy role may pass to ECS.
  EOT
  type        = list(string)
  default     = ["ooa-uat", "ooa"]
}

variable "ecr_keep_last" {
  description = "Images retained per ECR repository. SHA-only tagging grows forever without a lifecycle policy."
  type        = number
  default     = 50
}
