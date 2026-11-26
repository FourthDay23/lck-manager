#!/bin/sh
# lck-manager.kro.kr 인증서를 받을 때까지 재시도하고, 받으면 https를 확인한 뒤 타이머를 스스로 끈다.
# legatus-cert-retry.sh를 따랐다. 정적 사이트라 확인 주소가 / 이다.
# kro.kr은 Let's Encrypt 주당 50장 한도를 모든 kro.kr 사용자와 공유한다. 거절할 때 알려 주는
# "retry after" 시각을 저장해 두고 그 시각이 지나자마자 요청한다. 타이머는 1분마다 돌지만 그 전에는 보내지 않는다.
set -e
DOMAIN=lck-manager.kro.kr
MYIP=168.110.106.239
RETRY_AT=/var/lib/lck-manager-cert-retry-at
if [ ! -d /etc/letsencrypt/live/$DOMAIN ]; then
  # DNS가 이 서버를 가리키기 전에는 요청하지 않는다 (검증 실패 횟수 한도 보호)
  getent ahostsv4 $DOMAIN | awk '{print $1}' | grep -qx "$MYIP" || exit 0
  if [ -f "$RETRY_AT" ] && [ "$(date +%s)" -lt "$(cat "$RETRY_AT")" ]; then
    exit 0
  fi
  if ! out=$(certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect --hsts 2>&1); then
    when=$(printf '%s\n' "$out" | sed -n 's/.*retry after \([0-9-]* [0-9:]*\) UTC.*/\1/p' | head -n 1)
    if [ -n "$when" ]; then
      at=$(date -u -d "$when" +%s)
      echo $at > "$RETRY_AT"
      # 1분 타이머는 그 시각보다 최대 1분 늦다. 그 시각에 바로 한 번 더 돌도록 걸어 둔다(이름에 시각을 붙여 겹치지 않게).
      systemd-run --unit=lck-manager-cert-exact-$at --collect \
        --on-calendar="$(date -u -d @$at '+%Y-%m-%d %H:%M:%S') UTC" \
        --timer-property=AccuracySec=100ms /usr/local/sbin/lck-manager-cert-retry.sh >/dev/null 2>&1 || true
    else
      # 한도 말고 다른 이유로 실패했으면 30분 쉰다
      echo $(( $(date +%s) + 1800 )) > "$RETRY_AT"
    fi
    printf '%s\n' "$out" >&2
    exit 1
  fi
fi
# 인증서로 https가 실제로 열려야 끝낸다. 실패하면 다음 주기에 다시 본다.
curl -fsS --max-time 15 https://$DOMAIN/ >/dev/null
systemctl disable --now lck-manager-cert.timer
