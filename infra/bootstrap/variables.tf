variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "state_bucket_name" {
  description = "Globally unique. Convention: <slug>-terraform-state-<aws-account-id>."
  type        = string
  default     = "ooa-terraform-state-launchpadphilly"
}

variable "repository" {
  description = "Repository tag applied to the bucket."
  type        = string
  default     = "One_Off_Apparel"
}
