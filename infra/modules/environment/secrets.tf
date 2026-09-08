# The app-config secret CONTAINER only. Values are managed by humans via
# `aws secretsmanager put-secret-value` and never enter Terraform state or this
# repo; no aws_secretsmanager_secret_version resource may ever be added here.
# Production's pinned historical version (d964de5d-…, referenced by the
# migration tooling's version-addressed valueFrom) is untouched by design.
resource "aws_secretsmanager_secret" "app" {
  name                    = var.app_secret_name
  recovery_window_in_days = var.secret_recovery_window_days
  tags                    = local.common_tags
}
