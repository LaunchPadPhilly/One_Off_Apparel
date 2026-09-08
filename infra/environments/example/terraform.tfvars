# Bring-up state. Flip these in order (see infra/README.md):
#   1. first apply: both false, no images
#   2. after the registrar CNAMEs + cert ISSUED:
#        enable_https = true
#   3. after the secret is populated, pin both images to one built git SHA:
#        activate_services = true
#        image_uris = {
#          web = "<account-id>.dkr.ecr.<region>.amazonaws.com/<slug>-web:<40-hex-git-sha>"
#          mcp = "<account-id>.dkr.ecr.<region>.amazonaws.com/<slug>-mcp:<40-hex-git-sha>"
#        }
# After activation, CI owns image rollout; these pins are a recovery baseline only.
enable_https      = false
activate_services = false
image_uris        = {}
