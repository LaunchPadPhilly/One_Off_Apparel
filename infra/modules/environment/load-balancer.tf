resource "aws_lb" "this" {
  name               = local.alb_name
  load_balancer_type = "application"
  internal           = false
  ip_address_type    = "ipv4"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.alb_subnet_ids
  tags               = merge(local.common_tags, { Name = local.alb_name })
}

resource "aws_lb_target_group" "web" {
  name        = local.web_tg_name
  port        = local.web_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = var.web_health_check.path
    protocol            = "HTTP"
    port                = "traffic-port"
    interval            = var.web_health_check.interval
    timeout             = var.web_health_check.timeout
    healthy_threshold   = var.web_health_check.healthy
    unhealthy_threshold = var.web_health_check.unhealthy
    matcher             = "200"
  }

  tags = merge(local.common_tags, { Name = local.web_tg_name })
}

resource "aws_lb_target_group" "mcp" {
  name        = local.mcp_tg_name
  port        = local.mcp_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = var.mcp_health_check.path
    protocol            = "HTTP"
    port                = "traffic-port"
    interval            = var.mcp_health_check.interval
    timeout             = var.mcp_health_check.timeout
    healthy_threshold   = var.mcp_health_check.healthy
    unhealthy_threshold = var.mcp_health_check.unhealthy
    matcher             = "200"
  }

  tags = merge(local.common_tags, { Name = local.mcp_tg_name })
}

# :80 always redirects to https; plaintext never reaches a target group.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = local.common_tags
}

resource "aws_lb_listener" "https" {
  count             = var.enable_https ? 1 : 0
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.ssl_policy
  certificate_arn   = aws_acm_certificate.this.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  tags = local.common_tags
}

# Exact-path rule: the standalone mcp server serves only the literal /api/mcp
# (everything else 404s), so exact match is correct — no wildcard.
resource "aws_lb_listener_rule" "mcp" {
  count        = var.enable_https ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = var.mcp_rule_priority

  condition {
    path_pattern {
      values = ["/api/mcp"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.mcp.arn
  }

  tags = local.common_tags
}
