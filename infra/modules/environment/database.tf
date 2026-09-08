# Optional RDS instance: encrypted, private, on a dedicated security group, with an
# RDS-managed master password (nothing secret in state). Storage encryption and the
# initial database name are ForceNew — decide them at creation. The `create_rds =
# false` path exists for an environment that imports a pre-existing instance.
resource "aws_db_instance" "this" {
  count = var.create_rds ? 1 : 0

  identifier     = var.db_identifier
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = var.db_storage_encrypted

  db_name  = var.db_name
  username = var.db_master_username
  # Never set `password`; RDS manages the master credential and nothing enters state.
  manage_master_user_password = var.db_manage_master_password ? true : null

  publicly_accessible    = var.db_publicly_accessible
  multi_az               = false
  vpc_security_group_ids = [aws_security_group.db.id]

  backup_retention_period    = var.db_backup_retention
  backup_window              = var.db_backup_window
  maintenance_window         = var.db_maintenance_window
  auto_minor_version_upgrade = true
  deletion_protection        = var.db_deletion_protection
  ca_cert_identifier         = var.db_ca_cert_identifier
  parameter_group_name       = var.db_parameter_group_name
  copy_tags_to_snapshot      = false
  skip_final_snapshot        = var.environment != "production"
  final_snapshot_identifier  = var.environment == "production" ? "${var.db_identifier}-final" : null

  lifecycle {
    # Minor engine bumps are applied by AWS (auto_minor_version_upgrade);
    # don't fight them at plan time.
    ignore_changes = [engine_version]
  }

  tags = merge(local.common_tags, { Name = var.db_identifier })
}
