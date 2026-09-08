variable "aws_region" {
  type    = string
  default = "__AWS_REGION__"
}

variable "state_bucket_name" {
  description = "Globally unique. Convention: <slug>-terraform-state-<aws-account-id>."
  type        = string
  default     = "__STATE_BUCKET__"
}

variable "repository" {
  description = "Repository tag applied to the bucket."
  type        = string
  default     = "__GITHUB_REPO__"
}
