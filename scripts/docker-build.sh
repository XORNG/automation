#!/bin/bash

# XORNG Docker Build Script
# Builds all sub-agent containers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
XORNG_ROOT="$(dirname "$ROOT_DIR")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Build a single container
build_container() {
    local name=$1
    local path=$2
    local tag="${3:-latest}"

    if [ ! -f "$path/Dockerfile" ]; then
        log_warn "No Dockerfile found in $path, skipping $name"
        return 0
    fi

    log_info "Building $name:$tag from $path"
    docker build -t "xorng/$name:$tag" "$path"
    log_info "Successfully built xorng/$name:$tag"
}

# Build all validators
build_validators() {
    log_info "Building validator containers..."
    
    for dir in "$XORNG_ROOT"/validator-*/; do
        if [ -d "$dir" ]; then
            name=$(basename "$dir")
            build_container "$name" "$dir"
        fi
    done
}

# Build core
build_core() {
    log_info "Building core container..."
    build_container "core" "$XORNG_ROOT/core"
}

# Build all knowledge providers
build_knowledge() {
    log_info "Building knowledge containers..."
    
    for dir in "$XORNG_ROOT"/knowledge-*/; do
        if [ -d "$dir" ]; then
            name=$(basename "$dir")
            build_container "$name" "$dir"
        fi
    done
}

# Main build function
build_all() {
    log_info "Starting XORNG Docker build..."
    
    build_core
    build_validators
    build_knowledge
    
    log_info "All containers built successfully!"
}

# Parse arguments
case "${1:-all}" in
    all)
        build_all
        ;;
    core)
        build_core
        ;;
    validators)
        build_validators
        ;;
    knowledge)
        build_knowledge
        ;;
    *)
        build_container "$1" "$XORNG_ROOT/$1"
        ;;
esac
