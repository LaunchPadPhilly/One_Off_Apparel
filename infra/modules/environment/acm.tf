# DNS-validated certificate. This assumes the domain lives at an external registrar
# with no Route 53 zone in the account, so Terraform cannot place
# the validation record or wait on issuance:
#   - no aws_acm_certificate_validation resource, on purpose
#   - the validation CNAME is an output; a human places it at the registrar
#   - the :443 listener is gated behind var.enable_https, flipped only after
#     `aws acm describe-certificate` reports ISSUED
resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.common_tags, { Name = var.domain_name })
}
