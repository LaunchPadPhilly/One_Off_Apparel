output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_security_group_id" {
  value = aws_security_group.alb.id
}

output "web_task_security_group_id" {
  value = aws_security_group.web_task.id
}

output "mcp_task_security_group_id" {
  value = aws_security_group.mcp_task.id
}

output "db_security_group_id" {
  value = aws_security_group.db.id
}

output "web_target_group_arn" {
  value = aws_lb_target_group.web.arn
}

output "mcp_target_group_arn" {
  value = aws_lb_target_group.mcp.arn
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "web_service_name" {
  value = aws_ecs_service.web.name
}

output "mcp_service_name" {
  value = aws_ecs_service.mcp.name
}

output "service_subnet_ids" {
  value = var.service_subnet_ids
}

output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}

output "execution_role_name" {
  value = aws_iam_role.execution.name
}

output "certificate_arn" {
  value = aws_acm_certificate.this.arn
}

output "acm_validation_records" {
  description = "Place these at the external registrar to validate the certificate."
  value = [for o in aws_acm_certificate.this.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "db_endpoint" {
  value = var.create_rds ? aws_db_instance.this[0].endpoint : null
}

output "db_master_user_secret_arn" {
  description = "RDS-managed master credential secret (uat only)."
  value       = var.create_rds && var.db_manage_master_password ? aws_db_instance.this[0].master_user_secret[0].secret_arn : null
}
