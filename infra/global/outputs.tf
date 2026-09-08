output "ecr_web_url" {
  value = aws_ecr_repository.web.repository_url
}

output "ecr_mcp_url" {
  value = aws_ecr_repository.mcp.repository_url
}

output "github_deploy_role_arn" {
  value = aws_iam_role.github_deploy.arn
}
