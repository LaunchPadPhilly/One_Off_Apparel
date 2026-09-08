# Bootstrap root: creates the Terraform state bucket, so it cannot use that
# bucket itself — local state, gitignored. If the local state is ever lost:
#   terraform import aws_s3_bucket.state <state_bucket_name>
# (and the four sub-resources by bucket name) — see infra/README.md.
terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      ManagedBy  = "Terraform"
      Repository = var.repository
      Scope      = "bootstrap"
    }
  }
}
