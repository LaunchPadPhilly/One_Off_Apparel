data "aws_caller_identity" "current" {}

locals {
  common_tags = merge(var.tags, {
    ManagedBy   = "Terraform"
    Repository  = var.repository
    Environment = var.environment
  })

  cluster_name     = "${var.name_prefix}-cluster"
  web_service_name = "${var.name_prefix}-web"
  mcp_service_name = "${var.name_prefix}-mcp"
  web_tg_name      = "${var.name_prefix}-web-fargate-tg"
  mcp_tg_name      = "${var.name_prefix}-mcp-fargate-tg"
  alb_name         = "${var.name_prefix}-alb"

  web_port = 3000
  mcp_port = 3001

  # Flat-JSON secret keys each container reads (ECS per-key valueFrom). Both containers
  # MUST read the same DATABASE_URL: when they pointed at different databases, every OAuth
  # token the web app issued was unknown to the MCP server validating it.
  web_secret_keys = var.web_secret_keys
  mcp_secret_keys = var.mcp_secret_keys

  # Parked state (activate_services=false, no images yet): task definitions
  # register with an obviously-unrunnable placeholder; desired_count 0 means
  # nothing ever pulls it, and the activation check below blocks scale-up until
  # real pinned images replace it.
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${data.aws_region.current.region}.amazonaws.com"
  web_image    = lookup(var.image_uris, "web", "${local.ecr_registry}/${var.ecr_repository_prefix}-web:placeholder-not-deployable")
  mcp_image    = lookup(var.image_uris, "mcp", "${local.ecr_registry}/${var.ecr_repository_prefix}-mcp:placeholder-not-deployable")

  # Image tags must be pinned before activation: a 40-hex git SHA tag or a digest.
  image_pinned = alltrue([
    for uri in values(var.image_uris) :
    can(regex("(:[0-9a-f]{40}$|@sha256:[0-9a-f]{64}$)", uri))
  ])
}
