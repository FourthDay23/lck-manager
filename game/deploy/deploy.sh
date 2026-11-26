#!/bin/sh
# LCK 매니저를 dft-oracle에 올린다. game 폴더에서 실행: sh deploy/deploy.sh
#   1. 빌드 (샘플 데이터와 데이터 설명서는 빼고)
#   2. /var/www/lck-manager 교체 (이전 판은 /var/www/lck-manager.prev)
#   3. 처음 한 번만: nginx 사이트, 인증서 재시도 타이머 설치
set -e
HOST=${HOST:-dft-oracle}
cd "$(dirname "$0")/.."
npm run build
rm -rf dist/data-sample dist/data/README.md
tar -C dist -czf /tmp/lck-manager-dist.tgz .
scp /tmp/lck-manager-dist.tgz "$HOST":/tmp/lck-manager-dist.tgz
scp deploy/nginx-lck-manager.conf deploy/lck-manager-cert-retry.sh deploy/lck-manager-cert.service deploy/lck-manager-cert.timer "$HOST":/tmp/
ssh "$HOST" 'set -e
  sudo rm -rf /var/www/lck-manager.next && sudo mkdir -p /var/www/lck-manager.next
  sudo tar -xzf /tmp/lck-manager-dist.tgz -C /var/www/lck-manager.next
  sudo chown -R root:root /var/www/lck-manager.next && sudo chmod -R a+rX /var/www/lck-manager.next
  if [ -d /var/www/lck-manager ]; then sudo rm -rf /var/www/lck-manager.prev && sudo mv /var/www/lck-manager /var/www/lck-manager.prev; fi
  sudo mv /var/www/lck-manager.next /var/www/lck-manager
  if [ ! -f /etc/nginx/sites-available/lck-manager ]; then
    sudo cp /tmp/nginx-lck-manager.conf /etc/nginx/sites-available/lck-manager
    sudo ln -sf /etc/nginx/sites-available/lck-manager /etc/nginx/sites-enabled/lck-manager
    sudo nginx -t && sudo systemctl reload nginx
  fi
  if [ ! -f /usr/local/sbin/lck-manager-cert-retry.sh ]; then
    sudo install -m 755 /tmp/lck-manager-cert-retry.sh /usr/local/sbin/lck-manager-cert-retry.sh
    sudo install -m 644 /tmp/lck-manager-cert.service /etc/systemd/system/lck-manager-cert.service
    sudo install -m 644 /tmp/lck-manager-cert.timer /etc/systemd/system/lck-manager-cert.timer
    sudo systemctl daemon-reload
    [ -d /etc/letsencrypt/live/lck-manager.kro.kr ] || sudo systemctl enable --now lck-manager-cert.timer
  fi
  rm -f /tmp/lck-manager-dist.tgz
  echo deployed: $(ls /var/www/lck-manager/assets | tr "\n" " ")'
