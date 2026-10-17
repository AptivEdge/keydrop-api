variable "app_name" {
  type    = string
  default = "keydrop"
}

variable "environment" {
  type        = string
  description = "Deployment environment: dev, staging, or production."
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "db_name" {
  type    = string
  default = "keydrop"
}

variable "db_username" {
  type      = string
  default   = "keydrop_admin"
  sensitive = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_publicly_accessible" {
  type    = bool
  default = false
}

variable "container_port" {
  type    = number
  default = 4000
}

variable "container_cpu" {
  type    = number
  default = 256
}

variable "container_memory" {
  type    = number
  default = 512
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "image_tag" {
  type        = string
  description = "Immutable ECR image tag to deploy."
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "cloudwatch_log_group_name" {
  type    = string
  default = "/keydrop/api"
}

variable "cloudwatch_alarm_email" {
  type        = string
  default     = ""
  description = "Optional email address subscribed to CloudWatch alarm notifications."
}

variable "additional_log_groups" {
  type    = list(string)
  default = []
}

variable "enable_https" {
  type    = bool
  default = false
}

variable "assets_bucket_name" {
  type    = string
  default = ""
}

variable "assets_custom_domain_enabled" {
  type    = bool
  default = false
}

variable "assets_domain_name" {
  type    = string
  default = ""
}

variable "frontend_url" {
  type        = string
  description = "Comma-separated production frontend origins."
}

variable "api_domain_name" {
  type        = string
  default     = ""
  description = "Public API DNS name used for HTTPS and the Razorpay webhook endpoint."

  validation {
    condition     = var.environment != "production" || length(trimspace(var.api_domain_name)) > 0
    error_message = "api_domain_name is required in production."
  }
}

variable "acm_certificate_arn" {
  type        = string
  default     = ""
  description = "Issued ACM certificate ARN covering api_domain_name."

  validation {
    condition     = (var.environment != "production" || length(trimspace(var.acm_certificate_arn)) > 0) && ((length(trimspace(var.api_domain_name)) == 0) == (length(trimspace(var.acm_certificate_arn)) == 0))
    error_message = "Production requires an ACM certificate; configure api_domain_name and acm_certificate_arn together."
  }
}

variable "ses_from_email" {
  type      = string
  sensitive = true
}

variable "razorpay_key_id" {
  type      = string
  sensitive = true
}

variable "razorpay_key_secret" {
  type      = string
  sensitive = true
}

variable "razorpay_webhook_secret" {
  type      = string
  sensitive = true
}

variable "razorpay_pro_monthly_plan_id" {
  type = string
}

variable "razorpay_pro_yearly_plan_id" {
  type = string
}

variable "razorpay_team_monthly_plan_id" {
  type = string
}

variable "razorpay_team_yearly_plan_id" {
  type = string
}

variable "recipient_access_token_secret" {
  type      = string
  sensitive = true
}
