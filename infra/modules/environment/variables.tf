variable "environment" {
  description = "Environment name."
  type        = string
  validation {
    condition     = contains(["uat", "production"], var.environment)
    error_message = "environment must be uat or production."
  }
}

variable "name_prefix" {
  description = "Prefix for every resource name (<slug> for production, <slug>-uat for UAT)."
  type        = string
}

variable "tags" {
  description = "Extra tags merged into every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------- networking
variable "vpc_id" {
  description = "VPC to deploy into (the account default VPC; a data source in the root, never a managed resource)."
  type        = string
}

variable "service_subnet_ids" {
  description = "Public subnets the Fargate tasks run in (assign_public_ip, no NAT)."
  type        = list(string)
}

variable "alb_subnet_ids" {
  description = "Subnets the ALB spans (production spans three; services use two of them)."
  type        = list(string)
}

# ------------------------------------------------------------------- ALB/TLS
variable "domain_name" {
  description = "Public hostname served by the :443 listener's ACM certificate."
  type        = string
}

variable "enable_https" {
  description = "Create the :443 listener (+ /api/mcp rule). Keep false until the ACM certificate is ISSUED."
  type        = bool
  default     = true
}

variable "ssl_policy" {
  type    = string
  default = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "mcp_rule_priority" {
  type    = number
  default = 10
}

# Health-check settings; keep UAT and production identical.
variable "web_health_check" {
  type = object({
    path      = optional(string, "/api/health")
    interval  = optional(number, 15)
    timeout   = optional(number, 5)
    healthy   = optional(number, 2)
    unhealthy = optional(number, 3)
  })
  default = {}
}

variable "mcp_health_check" {
  type = object({
    path      = optional(string, "/health")
    interval  = optional(number, 30)
    timeout   = optional(number, 5)
    healthy   = optional(number, 3)
    unhealthy = optional(number, 3)
  })
  default = {}
}

# Security-group descriptions are ForceNew: changing one after creation replaces
# the group. Set them once.
variable "sg_descriptions" {
  type = object({
    alb = optional(string, "ALB - public HTTP/HTTPS ingress")
    web = optional(string, "web ECS Fargate task - inbound 3000 from ALB SG only")
    mcp = optional(string, "mcp ECS Fargate service - inbound 3001 from ALB only")
  })
  default = {}
}

variable "repository" {
  description = "Repository tag applied to every resource."
  type        = string
}

variable "ecr_repository_prefix" {
  description = "ECR repository name prefix (the `name_prefix` of infra/global). Only used for the parked placeholder image URI."
  type        = string
  default     = "ooa"
}

variable "web_secret_keys" {
  description = "Flat-JSON secret keys injected into the web container as individual environment variables."
  type        = list(string)
}

variable "mcp_secret_keys" {
  description = "Flat-JSON secret keys injected into the mcp container as individual environment variables."
  type        = list(string)
}

# ----------------------------------------------------------------------- ECS
variable "activate_services" {
  description = "Gate: false parks both services at desired_count 0 (safe with an unpopulated secret); true requires pinned image_uris when manage_task_definitions."
  type        = bool
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "manage_task_definitions" {
  description = "true (uat): Terraform registers the initial task definitions from image_uris. false (production): CI owns revisions; the service reads the latest ACTIVE revision via a data source."
  type        = bool
}

variable "image_uris" {
  description = "Container images, e.g. { web = \"<acct>.dkr.ecr.<region>.amazonaws.com/<slug>-web:<git-sha>\", mcp = ... }. Only used when manage_task_definitions."
  type        = map(string)
  default     = {}
}

variable "task_cpu" {
  type    = string
  default = "512"
}

variable "task_memory" {
  type    = string
  default = "1024"
}

variable "container_insights" {
  type    = string
  default = "disabled"
}

variable "enable_circuit_breaker" {
  description = "Deployment circuit breaker with rollback. Production imports with false (live value); uat true."
  type        = bool
}

# ----------------------------------------------------------------------- IAM
variable "execution_role_name" {
  description = "ECS task execution role name. Must match what infra/global allows the deploy role to pass: <name_prefix>-task-execution-role."
  type        = string
}

variable "create_task_role" {
  description = "Create an (empty) task role and attach it to managed task definitions — closes production's no-taskRoleArn gap greenfield in uat."
  type        = bool
  default     = false
}

# ------------------------------------------------------------------- secrets
variable "app_secret_name" {
  description = "Secrets Manager secret holding the flat JSON app config. Terraform manages the container only — never a version."
  type        = string
}

variable "secret_recovery_window_days" {
  type    = number
  default = 30
}

# ------------------------------------------------------------------- logging
variable "web_log_retention_days" {
  description = "null = never expire. Set a finite value in every root."
  type        = number
  default     = null
}

variable "mcp_log_retention_days" {
  type    = number
  default = 30
}

# ----------------------------------------------------------------------- RDS
variable "create_rds" {
  type = bool
}

variable "db_identifier" {
  type    = string
  default = null
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "db_engine_version" {
  type    = string
  default = "16.13"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_storage_encrypted" {
  type = bool
  # No default on purpose: encryption is ForceNew, so every root states it explicitly.
  nullable = false
}

variable "db_publicly_accessible" {
  type     = bool
  nullable = false
}

variable "db_master_username" {
  type    = string
  default = "app_admin"
}

variable "db_manage_master_password" {
  description = "true: RDS manages the master password and nothing enters state (recommended)."
  type        = bool
}

variable "db_name" {
  description = "Initial database name. ForceNew on an existing instance — set it at creation and never change it."
  type        = string
  default     = null
}

variable "db_deletion_protection" {
  type = bool
}

variable "db_backup_retention" {
  type    = number
  default = 7
}

variable "db_backup_window" {
  type    = string
  default = null
}

variable "db_maintenance_window" {
  type    = string
  default = null
}

variable "db_ca_cert_identifier" {
  type    = string
  default = null
}

variable "db_parameter_group_name" {
  type    = string
  default = null
}

