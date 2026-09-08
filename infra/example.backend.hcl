# Partial backend configuration shared by every root except bootstrap/.
# Copy to <anything>.backend.hcl (git-ignored), fill in, then:
#   terraform -chdir=infra/global init -backend-config=../my.backend.hcl
# The bucket is created by infra/bootstrap/ — its output `state_bucket` is this value.
bucket = "__STATE_BUCKET__"
region = "__AWS_REGION__"
