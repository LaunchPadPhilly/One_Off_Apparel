terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Bucket and region come from a partial config file (see infra/example.backend.hcl):
  #   terraform init -backend-config=../../my.backend.hcl
  # Each environment root needs its own `key`.
  backend "s3" {
    key          = "environments/uat/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      ManagedBy   = "Terraform"
      Repository  = var.repository
      Environment = var.environment
    }
  }
}
