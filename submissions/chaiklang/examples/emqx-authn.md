# EMQX HTTP authn -> ARRA-MQ verifier (EMQX 5.x)
authentication = [{
  mechanism = password_based
  backend   = http
  method    = post
  url       = "http://verifier:8787/connect"
  body      = { username = "${username}", password = "${password}", clientid = "${clientid}" }
  headers   { "content-type" = "application/json" }
  # verifier returns {"result":"allow"|"deny"}
}]
# authz (ACL): use built-in rules for PoC, or HTTP authz -> on-chain ARRA registry later
