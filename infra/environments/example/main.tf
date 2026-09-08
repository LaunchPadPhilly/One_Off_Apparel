# One deployable environment: its own ALB, ECS cluster with `web` and `mcp` Fargate
# services, security groups, IAM roles, log groups, Secrets Manager secret container,
# and a small encrypted PostgreSQL 16 RDS instance with an RDS-managed master password.
#
# Copy this directory once per environment (`uat/`, `production/`), change `environment`,
# `name_prefix`, `domain_name`, `app_secret_name` and the `key` in versions.tf, and keep
# everything else identical — the two environments should differ by name, not by shape.
#
# Bring-up gates (see infra/README.md). Each is one `terraform apply`:
#   1. apply with defaults        → parked: desired_count 0, no :443 listener
#   2. registrar records placed   → cert ISSUED → enable_https = true, apply
#   3. secret populated + images  → activate_services = true, apply

data "aws_vpc" "default" {
  default = true
}

# Public subnets of the default VPC. The ALB needs at least two AZs; the services use
# the same subnets with public IPs so Fargate can pull images without a NAT gateway.
# Replace with explicit ids for a non-default VPC.
data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

module "environment" {
  source = "../../modules/environment"

  environment = var.environment
  name_prefix = var.name_prefix
  repository  = var.repository

  vpc_id             = data.aws_vpc.default.id
  service_subnet_ids = data.aws_subnets.public.ids
  alb_subnet_ids     = data.aws_subnets.public.ids

  domain_name  = var.domain_name
  enable_https = var.enable_https

  activate_services       = var.activate_services
  manage_task_definitions = true
  image_uris              = var.image_uris
  enable_circuit_breaker  = true
  container_insights      = "disabled"

  # The deploy role (infra/global) may only pass roles named `<name_prefix>-task-execution-role`
  # and `<name_prefix>-task`; keep these defaults unless you also change global/variables.tf.
  execution_role_name = "${var.name_prefix}-task-execution-role"
  create_task_role    = true

  app_secret_name             = var.app_secret_name
  secret_recovery_window_days = 7
  web_log_retention_days      = 14
  mcp_log_retention_days      = 14

  # Flat-JSON keys each container receives from the secret. Must match the code's env
  # reads (.env.example documents them). A key missing here never reaches the container.
  web_secret_keys = var.web_secret_keys
  mcp_secret_keys = var.mcp_secret_keys

  create_rds                = true
  db_identifier             = "${var.name_prefix}-db"
  db_engine_version         = var.db_engine_version
  db_storage_encrypted      = true
  db_publicly_accessible    = false
  db_manage_master_password = true # RDS-managed; credential never in state
  db_name                   = var.db_name
  db_deletion_protection    = var.db_deletion_protection
}
