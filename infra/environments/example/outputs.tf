# The two values a human must take to the external registrar:
output "acm_validation_records" {
  description = "Place this CNAME at the registrar to validate the certificate."
  value       = module.environment.acm_validation_records
}

output "alb_dns_name" {
  description = "Point the environment hostname (var.domain_name) at this via CNAME."
  value       = module.environment.alb_dns_name
}

output "certificate_arn" {
  description = "ACM certificate for the environment hostname. Needed to poll issuance during bring-up, since validation happens at an external registrar with no Route 53 zone to automate."
  value       = module.environment.certificate_arn
}

output "cluster_name" {
  value = module.environment.cluster_name
}

output "web_service_name" {
  value = module.environment.web_service_name
}

output "mcp_service_name" {
  value = module.environment.mcp_service_name
}

output "service_subnet_ids" {
  value = module.environment.service_subnet_ids
}

output "web_task_security_group_id" {
  value = module.environment.web_task_security_group_id
}

output "mcp_task_security_group_id" {
  value = module.environment.mcp_task_security_group_id
}

output "execution_role_arn" {
  value = module.environment.execution_role_arn
}

output "app_secret_arn" {
  value = module.environment.app_secret_arn
}

output "db_endpoint" {
  value = module.environment.db_endpoint
}

output "db_master_user_secret_arn" {
  description = "RDS-managed master credential — source for the app secret's DATABASE_URL value. Build the string with scripts/fix-secret-database-url.sh; the endpoint output already includes the port."
  value       = module.environment.db_master_user_secret_arn
}
