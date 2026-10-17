resource "aws_ecr_repository" "main" {
  name                 = "${var.app_name}-${var.environment}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = var.environment != "production"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "main" {
  repository = aws_ecr_repository.main.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_lb" "main" {
  name               = "${var.app_name}-alb-${var.environment}"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = var.environment == "production"
}

resource "aws_lb_target_group" "main" {
  name        = "${var.app_name}-tg-${var.environment}"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/api/v1/health"
    matcher             = "200-399"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = var.acm_certificate_arn == "" ? "forward" : "redirect"
    target_group_arn = var.acm_certificate_arn == "" ? aws_lb_target_group.main.arn : null

    dynamic "redirect" {
      for_each = var.acm_certificate_arn == "" ? [] : [1]
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.acm_certificate_arn == "" ? 0 : 1
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.acm_certificate_arn
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.main.arn
  }
}

resource "aws_ecs_cluster" "main" {
  name = "${var.app_name}-cluster-${var.environment}"

  setting {
    name  = "containerInsights"
    value = var.environment == "production" ? "enabled" : "disabled"
  }
}

resource "aws_ecs_task_definition" "main" {
  family                   = "${var.app_name}-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.container_cpu
  memory                   = var.container_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = var.app_name
    image     = "${aws_ecr_repository.main.repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.container_port
      hostPort      = var.container_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = tostring(var.container_port) },
      { name = "COGNITO_REGION", value = var.aws_region },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "S3_REGION", value = var.aws_region },
      { name = "S3_BUCKET", value = aws_s3_bucket.assets.bucket },
      { name = "ASSETS_CUSTOM_DOMAIN", value = tostring(var.assets_custom_domain_enabled) },
      { name = "ASSETS_DOMAIN_NAME", value = var.assets_domain_name },
      { name = "ASSETS_URL", value = "https://${aws_s3_bucket.assets.bucket_regional_domain_name}" },
      { name = "ENABLE_HTTPS", value = tostring(var.enable_https) },
    ]

    secrets = [
      {
        name      = "DATABASE_URL"
        valueFrom = "${aws_secretsmanager_secret.db_credentials.arn}:connection_string::"
      },
      {
        name      = "USER_COGNITO_USER_POOL_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:user_cognito_user_pool_id::"
      },
      {
        name      = "USER_COGNITO_CLIENT_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:user_cognito_client_id::"
      },
      {
        name      = "ADMIN_COGNITO_USER_POOL_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:admin_cognito_user_pool_id::"
      },
      {
        name      = "ADMIN_COGNITO_CLIENT_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:admin_cognito_client_id::"
      },
      {
        name      = "FRONTEND_URL"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:frontend_url::"
      },
      {
        name      = "SES_REGION"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:ses_region::"
      },
      {
        name      = "SES_FROM_EMAIL"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:ses_from_email::"
      },
      {
        name      = "RAZORPAY_KEY_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_key_id::"
      },
      {
        name      = "RAZORPAY_KEY_SECRET"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_key_secret::"
      },
      {
        name      = "RAZORPAY_WEBHOOK_SECRET"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_webhook_secret::"
      },
      {
        name      = "RAZORPAY_PRO_MONTHLY_PLAN_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_pro_monthly_plan_id::"
      },
      {
        name      = "RAZORPAY_PRO_YEARLY_PLAN_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_pro_yearly_plan_id::"
      },
      {
        name      = "RAZORPAY_TEAM_MONTHLY_PLAN_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_team_monthly_plan_id::"
      },
      {
        name      = "RAZORPAY_TEAM_YEARLY_PLAN_ID"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:razorpay_team_yearly_plan_id::"
      },
      {
        name      = "RECIPIENT_ACCESS_TOKEN_SECRET"
        valueFrom = "${aws_secretsmanager_secret.app_secrets.arn}:recipient_access_token_secret::"
      },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.application_logs.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "ecs"
      }
    }
  }])
}

resource "aws_ecs_service" "main" {
  name            = "${var.app_name}-service-${var.environment}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.main.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.main.arn
    container_name   = var.app_name
    container_port   = var.container_port
  }
}
