resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.web_service_name}"
  retention_in_days = var.web_log_retention_days
  tags              = local.common_tags
}

resource "aws_cloudwatch_log_group" "mcp" {
  name              = "/ecs/${local.mcp_service_name}"
  retention_in_days = var.mcp_log_retention_days
  tags              = local.common_tags
}
