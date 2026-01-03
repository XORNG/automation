#!/bin/bash

# XORNG Development Setup Script
# Sets up the local development environment

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
XORNG_ROOT="$(dirname "$ROOT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed. Please install Node.js 20+."
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        log_error "Node.js 20+ is required. Current version: $(node -v)"
        exit 1
    fi
    log_info "Node.js $(node -v) ✓"

    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed."
        exit 1
    fi
    log_info "npm $(npm -v) ✓"

    # Check Docker
    if ! command -v docker &> /dev/null; then
        log_warn "Docker is not installed. Container features will not work."
    else
        log_info "Docker $(docker --version | cut -d' ' -f3 | tr -d ',') ✓"
    fi

    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
        log_warn "Docker Compose is not installed. Orchestration features will not work."
    else
        log_info "Docker Compose ✓"
    fi
}

# Install dependencies for a package
install_deps() {
    local dir=$1
    local name=$(basename "$dir")

    if [ -f "$dir/package.json" ]; then
        log_info "Installing dependencies for $name..."
        (cd "$dir" && npm install)
    fi
}

# Build a package
build_package() {
    local dir=$1
    local name=$(basename "$dir")

    if [ -f "$dir/package.json" ]; then
        log_info "Building $name..."
        (cd "$dir" && npm run build)
    fi
}

# Setup all packages
setup_all() {
    log_info "Setting up XORNG Framework..."

    # Core packages first
    local core_packages=(
        "core"
        "node"
        "template-base"
        "template-validator"
        "template-task"
        "template-knowledge"
    )

    for pkg in "${core_packages[@]}"; do
        if [ -d "$XORNG_ROOT/$pkg" ]; then
            install_deps "$XORNG_ROOT/$pkg"
        fi
    done

    # Build core packages in order
    for pkg in "${core_packages[@]}"; do
        if [ -d "$XORNG_ROOT/$pkg" ]; then
            build_package "$XORNG_ROOT/$pkg"
        fi
    done

    # Sub-agents
    for dir in "$XORNG_ROOT"/validator-* "$XORNG_ROOT"/knowledge-*; do
        if [ -d "$dir" ]; then
            install_deps "$dir"
            build_package "$dir"
        fi
    done

    # Automation
    install_deps "$ROOT_DIR"
    build_package "$ROOT_DIR"

    log_info "Setup complete!"
}

# Create environment files
create_env_files() {
    log_info "Creating environment files..."

    # Core .env
    if [ ! -f "$XORNG_ROOT/core/.env" ]; then
        if [ -f "$XORNG_ROOT/core/.env.example" ]; then
            cp "$XORNG_ROOT/core/.env.example" "$XORNG_ROOT/core/.env"
            log_info "Created core/.env from example"
        fi
    fi

    # Node .env
    if [ ! -f "$XORNG_ROOT/node/.env" ]; then
        cat > "$XORNG_ROOT/node/.env" << EOF
# OpenAI Configuration
OPENAI_API_KEY=your-openai-api-key

# Anthropic Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key

# Local Model Configuration (optional)
LOCAL_MODEL_URL=http://localhost:11434
EOF
        log_info "Created node/.env"
    fi
}

# Main
main() {
    check_prerequisites
    create_env_files
    setup_all
}

main "$@"
