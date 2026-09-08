# Security groups use standalone rule resources (not inline blocks) so each rule
# is addressable on its own and additions never rewrite the whole group.

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb-sg"
  description = var.sg_descriptions.alb
  vpc_id      = var.vpc_id
  tags        = merge(local.common_tags, { Name = "${var.name_prefix}-alb-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_all" {
  security_group_id = aws_security_group.alb.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "web_task" {
  name        = "${var.name_prefix}-web-ecs-sg"
  description = var.sg_descriptions.web
  vpc_id      = var.vpc_id
  tags        = merge(local.common_tags, { Name = "${var.name_prefix}-web-ecs-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web_task.id
  ip_protocol                  = "tcp"
  from_port                    = local.web_port
  to_port                      = local.web_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "web_all" {
  security_group_id = aws_security_group.web_task.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "mcp_task" {
  name        = "${var.name_prefix}-mcp-ecs-sg"
  description = var.sg_descriptions.mcp
  vpc_id      = var.vpc_id
  tags        = merge(local.common_tags, { Name = "${var.name_prefix}-mcp-ecs-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "mcp_from_alb" {
  security_group_id            = aws_security_group.mcp_task.id
  ip_protocol                  = "tcp"
  from_port                    = local.mcp_port
  to_port                      = local.mcp_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "mcp_all" {
  security_group_id = aws_security_group.mcp_task.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Dedicated DB security group: 5432 from the two task SGs only.
resource "aws_security_group" "db" {
  name        = "${var.name_prefix}-db-sg"
  description = "${var.name_prefix} RDS - 5432 from the web/mcp task SGs only"
  vpc_id      = var.vpc_id
  tags        = merge(local.common_tags, { Name = "${var.name_prefix}-db-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "db_from_web" {
  security_group_id            = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.web_task.id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_mcp" {
  security_group_id            = aws_security_group.db.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.mcp_task.id
}

resource "aws_vpc_security_group_egress_rule" "db_all" {
  security_group_id = aws_security_group.db.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
