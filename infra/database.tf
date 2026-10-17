resource "aws_db_subnet_group" "main" {
  name       = "${var.app_name}-db-subnets-${var.environment}"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.app_name}-db-params-${var.environment}"
  family = "postgres15"

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "main" {
  identifier              = "${var.app_name}-db-${var.environment}"
  engine                  = "postgres"
  engine_version          = "15.19"
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage
  storage_type            = "gp3"
  storage_encrypted       = true
  username                = var.db_username
  password                = var.db_password
  db_name                 = var.db_name
  port                    = 5432
  publicly_accessible     = var.db_publicly_accessible
  multi_az                = var.environment == "production"
  db_subnet_group_name    = aws_db_subnet_group.main.name
  parameter_group_name    = aws_db_parameter_group.main.name
  vpc_security_group_ids  = [aws_security_group.rds.id]
  backup_retention_period = var.environment == "production" ? 7 : 1
  skip_final_snapshot     = var.environment != "production"
  deletion_protection     = var.environment == "production"

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
}
