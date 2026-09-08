resource "aws_ecs_cluster" "this" {
  name = local.cluster_name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }

  tags = merge(local.common_tags, { Name = local.cluster_name })
}

# Production: CI (GitHub Actions) owns task-definition revisions — Terraform
# manages none and reads the latest ACTIVE revision only to satisfy the service
# argument. uat: Terraform registers the initial definitions from image_uris;
# after activation, CLI/CI deploys advance revisions freely under the same
# ignore_changes.
data "aws_ecs_task_definition" "web" {
  count           = var.manage_task_definitions ? 0 : 1
  task_definition = local.web_service_name
}

data "aws_ecs_task_definition" "mcp" {
  count           = var.manage_task_definitions ? 0 : 1
  task_definition = local.mcp_service_name
}

resource "aws_ecs_task_definition" "web" {
  count                    = var.manage_task_definitions ? 1 : 0
  family                   = local.web_service_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = var.create_task_role ? aws_iam_role.task[0].arn : null

  container_definitions = jsonencode([{
    name      = "web"
    image     = local.web_image
    essential = true
    portMappings = [{
      containerPort = local.web_port
      protocol      = "tcp"
    }]
    secrets = [for key in local.web_secret_keys : {
      name      = key
      valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.web.name
        "awslogs-region"        = data.aws_region.current.region
        "awslogs-stream-prefix" = "web"
      }
    }
  }])

  tags = local.common_tags
}

resource "aws_ecs_task_definition" "mcp" {
  count                    = var.manage_task_definitions ? 1 : 0
  family                   = local.mcp_service_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = var.create_task_role ? aws_iam_role.task[0].arn : null

  container_definitions = jsonencode([{
    name      = "mcp"
    image     = local.mcp_image
    essential = true
    portMappings = [{
      containerPort = local.mcp_port
      protocol      = "tcp"
    }]
    secrets = [for key in local.mcp_secret_keys : {
      name      = key
      valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::"
    }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.mcp.name
        "awslogs-region"        = data.aws_region.current.region
        "awslogs-stream-prefix" = "mcp"
      }
    }
  }])

  tags = local.common_tags
}

data "aws_region" "current" {}

resource "aws_ecs_service" "web" {
  name            = local.web_service_name
  cluster         = aws_ecs_cluster.this.id
  launch_type     = "FARGATE"
  desired_count   = var.activate_services ? var.desired_count : 0
  task_definition = var.manage_task_definitions ? aws_ecs_task_definition.web[0].arn : data.aws_ecs_task_definition.web[0].arn

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 0
  enable_execute_command             = false
  enable_ecs_managed_tags            = false
  propagate_tags                     = "NONE"

  deployment_circuit_breaker {
    enable   = var.enable_circuit_breaker
    rollback = var.enable_circuit_breaker
  }

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.web_task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = local.web_port
  }

  # ECS refuses CreateService on a target group not yet associated with a load
  # balancer; in redirect mode the web/mcp TGs only attach via the :443 listener
  # and its /api/mcp rule, so service creation must wait for the listeners.
  depends_on = [aws_lb_listener.http, aws_lb_listener.https, aws_lb_listener_rule.mcp]

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = local.common_tags
}

resource "aws_ecs_service" "mcp" {
  name            = local.mcp_service_name
  cluster         = aws_ecs_cluster.this.id
  launch_type     = "FARGATE"
  desired_count   = var.activate_services ? var.desired_count : 0
  task_definition = var.manage_task_definitions ? aws_ecs_task_definition.mcp[0].arn : data.aws_ecs_task_definition.mcp[0].arn

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100
  health_check_grace_period_seconds  = 0
  enable_execute_command             = false
  enable_ecs_managed_tags            = false
  propagate_tags                     = "NONE"

  deployment_circuit_breaker {
    enable   = var.enable_circuit_breaker
    rollback = var.enable_circuit_breaker
  }

  network_configuration {
    subnets          = var.service_subnet_ids
    security_groups  = [aws_security_group.mcp_task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.mcp.arn
    container_name   = "mcp"
    container_port   = local.mcp_port
  }

  # ECS refuses CreateService on a target group not yet associated with a load
  # balancer; in redirect mode the web/mcp TGs only attach via the :443 listener
  # and its /api/mcp rule, so service creation must wait for the listeners.
  depends_on = [aws_lb_listener.http, aws_lb_listener.https, aws_lb_listener_rule.mcp]

  lifecycle {
    ignore_changes = [task_definition]
  }

  tags = local.common_tags
}

# Activation gate: refuse to scale up on unpinned images.
check "activation_inputs" {
  assert {
    condition = !(var.activate_services && var.manage_task_definitions) || (
      length(var.image_uris) == 2 && local.image_pinned
    )
    error_message = "activate_services=true with Terraform-managed task definitions requires image_uris.web and image_uris.mcp pinned to a 40-hex git SHA tag or an @sha256 digest."
  }
}
