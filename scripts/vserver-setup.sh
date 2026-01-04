#!/bin/bash
# XORNG Automation Server - Initial VServer Setup Script
# Run this once on your Debian VServer to prepare it for deployments
#
# Usage: curl -fsSL <url> | sudo bash
#
# Options:
#   --no-firewall    Skip UFW firewall setup (if using provider's firewall)
#   SKIP_FIREWALL=1  Environment variable alternative
#
# Examples:
#   curl -fsSL <url> | sudo bash                    # Full setup with firewall
#   curl -fsSL <url> | sudo bash -s -- --no-firewall # Skip firewall
#   SKIP_FIREWALL=1 sudo ./vserver-setup.sh         # Skip firewall (env var)
#
# This is the ONLY manual step required. After running this:
# - Configure GitHub secrets
# - Push to main branch
# - Everything else (including Traefik) is handled automatically!

set -e

echo "=== XORNG Automation Server Setup ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo ./vserver-setup.sh)"
  exit 1
fi

echo "1. Updating system packages..."
apt-get update
apt-get upgrade -y

echo ""
echo "2. Installing Docker..."
if ! command -v docker &> /dev/null; then
  apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
  
  curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
  
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  
  systemctl enable docker
  systemctl start docker
  
  echo "Docker installed successfully"
else
  echo "Docker already installed"
fi

echo ""
echo "3. Creating deploy user..."
if ! id "deploy" &>/dev/null; then
  useradd -m -s /bin/bash deploy
  usermod -aG docker deploy
  echo "Created user 'deploy' with Docker access"
else
  echo "User 'deploy' already exists"
  usermod -aG docker deploy
fi

echo ""
echo "4. Setting up SSH for deploy user..."
mkdir -p /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh

echo ""
echo "5. Installing additional tools..."
apt-get install -y curl wget jq htop

echo ""
echo "6. Firewall setup (UFW)..."
# Skip firewall if --no-firewall flag is passed or SKIP_FIREWALL=1
if [ "$SKIP_FIREWALL" = "1" ] || [[ " $* " =~ " --no-firewall " ]]; then
  echo "Skipping firewall setup (--no-firewall or SKIP_FIREWALL=1)"
else
  if ! command -v ufw &> /dev/null; then
    apt-get install -y ufw
  fi

  ufw default deny incoming
  ufw default allow outgoing
  ufw allow ssh
  ufw allow 80/tcp    # HTTP (for Let's Encrypt challenge & redirect)
  ufw allow 443/tcp   # HTTPS (main traffic)
  ufw allow 3001/tcp  # Direct access (when not using domain)

  echo "y" | ufw enable
  ufw status
fi

echo ""
echo "7. Setting up log rotation for Docker..."
cat > /etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF

systemctl restart docker

echo ""
echo "8. Creating deployment directory..."
mkdir -p /opt/xorng
chown deploy:deploy /opt/xorng

echo ""
echo "=== Setup Complete ==="
echo ""
echo "===================================================================================="
echo "                           NEXT STEPS (One-Time Setup)                              "
echo "===================================================================================="
echo ""
echo "1. Generate SSH key for GitHub Actions:"
echo "   ssh-keygen -t ed25519 -C 'github-actions-deploy' -f ~/.ssh/xorng-deploy"
echo ""
echo "2. Add the PUBLIC key to this server:"
echo "   ssh-copy-id -i ~/.ssh/xorng-deploy.pub deploy@$(hostname -I | awk '{print $1}')"
echo ""
echo "3. Configure GitHub repository secrets (Settings → Secrets → Actions):"
echo ""
echo "   REQUIRED:"
echo "   ┌─────────────────────┬────────────────────────────────────────────────────┐"
echo "   │ VSERVER_HOST        │ $(hostname -I | awk '{print $1}')                  │"
echo "   │ VSERVER_USER        │ deploy                                             │"
echo "   │ VSERVER_SSH_KEY     │ (contents of ~/.ssh/xorng-deploy private key)      │"
echo "   │ GH_AUTOMATION_TOKEN │ GitHub token with repo & admin:org scopes          │"
echo "   │ WEBHOOK_SECRET      │ $(openssl rand -hex 32)                            │"
echo "   │ GH_ORG              │ Your organization name (e.g., XORNG)               │"
echo "   └─────────────────────┴────────────────────────────────────────────────────┘"
echo ""
echo "   FOR DOMAIN + HTTPS (Recommended):"
echo "   ┌─────────────────────┬────────────────────────────────────────────────────┐"
echo "   │ AUTOMATION_DOMAIN   │ Your domain (e.g., automation.example.com)         │"
echo "   │ ACME_EMAIL          │ Email for Let's Encrypt (optional)                 │"
echo "   └─────────────────────┴────────────────────────────────────────────────────┘"
echo ""
echo "4. Point your domain's DNS A record to: $(hostname -I | awk '{print $1}')"
echo ""
echo "5. Push to main branch - deployment happens automatically!"
echo ""
echo "===================================================================================="
echo "                              ZERO MAINTENANCE MODE                                 "
echo "===================================================================================="
echo ""
echo "Once configured, the system is fully automated:"
echo "  ✓ Traefik reverse proxy starts automatically (if AUTOMATION_DOMAIN is set)"
echo "  ✓ SSL certificates provisioned via Let's Encrypt"
echo "  ✓ HTTP → HTTPS redirect"
echo "  ✓ Daily update checks"
echo "  ✓ Automatic container restarts"
echo ""
echo "You don't need to maintain anything on this server!"
echo ""
