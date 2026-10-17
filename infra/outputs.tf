output "vpc_id" {
  value = aws_vpc.main.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.main.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.main.name
}

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "razorpay_webhook_url" {
  value = var.api_domain_name == "" ? "" : "https://${var.api_domain_name}/api/v1/webhooks/razorpay"
}

output "database_endpoint" {
  value = aws_db_instance.main.address
}

output "assets_bucket" {
  value = aws_s3_bucket.assets.bucket
}

output "user_cognito_user_pool_id" {
  value = aws_cognito_user_pool.user_pool.id
}

output "user_cognito_client_id" {
  value = aws_cognito_user_pool_client.user_client.id
}

output "admin_cognito_user_pool_id" {
  value = aws_cognito_user_pool.admin_pool.id
}

output "admin_cognito_client_id" {
  value = aws_cognito_user_pool_client.admin_client.id
}

output "application_log_group" {
  value = aws_cloudwatch_log_group.application_logs.name
}

output "cloudwatch_alarm_topic_arn" {
  value = aws_sns_topic.cloudwatch_alarms.arn
}
