resource "aws_secretsmanager_secret" "app_secrets" {
  name        = "${var.app_name}/app/${var.environment}"
  description = "Keydrop application secrets for ${var.environment}"
}

resource "aws_secretsmanager_secret_version" "app_secrets" {
  secret_id = aws_secretsmanager_secret.app_secrets.id

  secret_string = jsonencode({
    user_cognito_user_pool_id     = aws_cognito_user_pool.user_pool.id
    user_cognito_client_id        = aws_cognito_user_pool_client.user_client.id
    admin_cognito_user_pool_id    = aws_cognito_user_pool.admin_pool.id
    admin_cognito_client_id       = aws_cognito_user_pool_client.admin_client.id
    cognito_region                = var.aws_region
    ses_region                    = var.aws_region
    s3_region                     = var.aws_region
    s3_bucket                     = aws_s3_bucket.assets.bucket
    frontend_url                  = var.frontend_url
    ses_from_email                = var.ses_from_email
    razorpay_key_id               = var.razorpay_key_id
    razorpay_key_secret           = var.razorpay_key_secret
    razorpay_webhook_secret       = var.razorpay_webhook_secret
    razorpay_pro_monthly_plan_id  = var.razorpay_pro_monthly_plan_id
    razorpay_pro_yearly_plan_id   = var.razorpay_pro_yearly_plan_id
    razorpay_team_monthly_plan_id = var.razorpay_team_monthly_plan_id
    razorpay_team_yearly_plan_id  = var.razorpay_team_yearly_plan_id
    recipient_access_token_secret = var.recipient_access_token_secret
  })
}

resource "aws_secretsmanager_secret" "db_credentials" {
  name        = "${var.app_name}/database/${var.environment}"
  description = "Keydrop PostgreSQL credentials for ${var.environment}"
}

resource "aws_secretsmanager_secret_version" "db_credentials" {
  secret_id = aws_secretsmanager_secret.db_credentials.id

  secret_string = jsonencode({
    username          = var.db_username
    password          = var.db_password
    engine            = "postgres"
    host              = aws_db_instance.main.address
    port              = aws_db_instance.main.port
    dbname            = var.db_name
    connection_string = "postgresql://${var.db_username}:${urlencode(var.db_password)}@${aws_db_instance.main.endpoint}/${var.db_name}?schema=public&sslmode=require"
  })
}
