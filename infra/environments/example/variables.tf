variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  description = "Short environment label used in tags: uat | production."
  type        = string
  default     = "uat"
}

variable "name_prefix" {
  description = "Prefix for every resource in this environment. Convention: <slug> for production, <slug>-uat for UAT."
  type        = string
  default     = "ooa-uat"
}

variable "repository" {
  description = "Repository tag applied to every resource."
  type        = string
  default     = "One_Off_Apparel"
}

variable "domain_name" {
  description = "Hostname the ALB certificate is issued for. The registrar CNAME is placed by hand (see infra/README.md)."
  type        = string
  default     = "uat.ooa.launchpadphilly.org"
}

variable "app_secret_name" {
  description = "Secrets Manager secret holding the flat JSON of runtime keys. Terraform creates the container only; values are always human-written."
  type        = string
  default     = "uat/ooa/app"
}

variable "web_secret_keys" {
  description = "Secret keys injected into the web container. Keep in lockstep with .env.example."
  type        = list(string)
  default = [
    "DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "GOOGLE_ALLOWED_DOMAIN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI",
    "INITIAL_ADMIN_EMAIL",
    "MCP_OAUTH_ISSUER_URL", "MCP_OAUTH_SCOPES", "MCP_PUBLIC_URL",
  ]
}

variable "mcp_secret_keys" {
  description = "Secret keys injected into the mcp container. Must include every key the tools in src/lib/server/mcp/tools.ts read."
  type        = list(string)
  default     = ["DATABASE_URL", "MCP_OAUTH_ISSUER_URL"]
}

variable "db_name" {
  description = "Initial database name. Must match the path segment of DATABASE_URL in the secret."
  type        = string
  default     = "ooa"
}

variable "db_engine_version" {
  description = "PostgreSQL engine version. Pin UAT and production to the same value."
  type        = string
  default     = "16.13"
}

variable "db_deletion_protection" {
  description = "false for a disposable UAT; true for production."
  type        = bool
  default     = false
}

variable "enable_https" {
  description = "Flip to true only after the ACM validation CNAME is placed at the registrar and the certificate reports ISSUED."
  type        = bool
  default     = false
}

variable "activate_services" {
  description = "Flip to true only after the secret is populated and image_uris are pinned."
  type        = bool
  default     = false
}

variable "image_uris" {
  description = "ECR image URIs pinned to a 40-hex git SHA, e.g. { web = \"<acct>.dkr.ecr.<region>.amazonaws.com/<slug>-web:<sha>\", mcp = ... }. Bring-up/recovery baseline only: CI owns task-definition revisions after that."
  type        = map(string)
  default     = {}
}
