terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Backends cannot read variables, so the bucket lives in a partial config file:
  #   terraform init -backend-config=../example.backend.hcl
  # Copy infra/example.backend.hcl, fill it, and keep the filled copy out of git
  # (*.backend.hcl is ignored; only the example is committed).
  backend "s3" {
    key          = "global/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      ManagedBy  = "Terraform"
      Repository = var.github_repo
      Scope      = "global"
    }
  }
}
