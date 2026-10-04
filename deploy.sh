#!/bin/bash

# ==============================================================================
# LanguageAIApp Deployment Script with macOS Keychain Integration
# ==============================================================================
#
# This script deploys the LanguageAIApp to a remote server using SSH.
# It integrates with macOS Keychain to securely store and retrieve SSH passwords.
#
# KEYCHAIN INTEGRATION:
# --------------------
# 1. First Run: The script will try to retrieve the password from Keychain. 
#    If it doesn't exist, it will:
#    - Prompt you to enter the password manually
#    - Ask if you want to store it in Keychain for future use
#    - If you say yes, it stores the password securely
#
# 2. Subsequent Runs: The script will automatically retrieve the password 
#    from Keychain without any prompts
#
# 3. Authorization: The first time you store or access a password in Keychain, 
#    macOS will prompt you to authorize terminal access. You can choose to 
#    "Always Allow" so it won't prompt again.
#
# BENEFITS:
# ---------
# - Security: Password is encrypted and stored securely in Keychain
# - Convenience: No need to type password every time
# - Control: You control when to store/update the password
# - Fallback: Still works if Keychain access fails
#
# MANUAL KEYCHAIN MANAGEMENT:
# ---------------------------
# Store password manually:
#   security add-generic-password -a "user@host" -s "language-ai-app-deploy" -w
#
# View stored password (will prompt for authorization):
#   security find-generic-password -a "user@host" -s "language-ai-app-deploy" -w
#
# Delete stored password:
#   security delete-generic-password -a "user@host" -s "language-ai-app-deploy"
#
# USAGE:
# ------
# All deployment modes require REGISTRY_HOST.
# Build, push, and deploy:  ./deploy.sh
# Deploy only:              ./deploy.sh --deploy-only
#                          ./deploy.sh -d
# Follow logs:              ./deploy.sh --follow-logs
#                          ./deploy.sh -f
# Combined:                 ./deploy.sh -d -f
#
# ==============================================================================

# Exit on error
set -e

# Change to script directory
cd "$(dirname "$0")"

# Load environment variables
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

# Configuration
REMOTE_HOST=${REMOTE_HOST:-}
REMOTE_USER=${REMOTE_USER:-ubuntu}
DEPLOY_PATH=${DEPLOY_PATH:-/home/${REMOTE_USER}/language-ai-app}
KEYCHAIN_SERVICE="language-ai-app-deploy"
KEYCHAIN_ACCOUNT="$REMOTE_USER@$REMOTE_HOST"

# Docker configuration
IMAGE_NAME=${IMAGE_NAME:-language-ai-app}
IMAGE_TAG=${IMAGE_TAG:-latest}
REGISTRY_HOST=${REGISTRY_HOST:-}
REGISTRY_PORT=${REGISTRY_PORT:-5010}

# Port configuration
DEPLOY_PORT=${DEPLOY_PORT:-3000}
CACHE_HOST_DIR=${CACHE_HOST_DIR:-/var/lib/language-ai-app}

# Default flag values
FOLLOW_LOGS=false
DEPLOY_ONLY=false

# Parse command line arguments
parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            -f|--follow-logs)
                FOLLOW_LOGS=true
                shift
                ;;
            -d|--deploy-only)
                DEPLOY_ONLY=true
                shift
                ;;
            -h|--help)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  -f, --follow-logs    Follow container logs after deployment"
                echo "  -d, --deploy-only    Skip build and push, deploy only"
                echo "  -h, --help          Show this help message"
                echo ""
                echo "Examples:"
                echo "  $0                  Build, push, and deploy"
                echo "  $0 -f               Build, push, deploy, and follow logs"
                echo "  $0 -d               Deploy only (skip build and push)"
                echo "  $0 -d -f            Deploy only and follow logs"
                echo ""
                        echo "Configuration:"
        echo "  Set REMOTE_HOST, REMOTE_USER, and DEPLOY_PATH in .env file"
        echo "  REGISTRY_HOST is required in every deployment mode, including --deploy-only"
        echo "  Set REGISTRY_PORT, IMAGE_NAME, and IMAGE_TAG for the image to deploy"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                echo "Use -h or --help for usage information"
                exit 1
                ;;
        esac
    done
}

# Function to get password from keychain or prompt for it
get_password() {
    echo "🔐 Retrieving SSH password from Keychain..."
    
    # Try to get password from keychain
    PASSWORD=$(security find-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || echo "")
    
    if [ -z "$PASSWORD" ]; then
        echo "❌ Password not found in Keychain."
        echo
        echo "💡 To store your password in Keychain manually, run this command:"
        echo "   security add-generic-password -a \"$KEYCHAIN_ACCOUNT\" -s \"$KEYCHAIN_SERVICE\" -w"
        echo "   (This will prompt you securely for the password)"
        echo
        prompt_for_password
        
        # Ask if user wants to store password in keychain
        echo
        echo -n "Would you like to store this password in Keychain for future use? (y/n): "
        read -r store_password
        if [[ "$store_password" =~ ^[Yy]$ ]]; then
            echo "🔐 Storing password in Keychain..."
            if security add-generic-password -a "$KEYCHAIN_ACCOUNT" -s "$KEYCHAIN_SERVICE" -w "$PASSWORD" 2>/dev/null; then
                echo "✅ Password stored successfully in Keychain."
            else
                echo "⚠️  Failed to store password in Keychain, but continuing with deployment."
            fi
        fi
    else
        echo "✅ Password retrieved from Keychain."
        # Test the password before proceeding
        if ! test_ssh_connection; then
            echo "❌ Keychain password appears to be incorrect."
            echo "🔄 Please enter the correct password:"
            prompt_for_password
            
            # Suggest updating keychain
            echo
            echo "💡 To update your Keychain with the correct password, run:"
            echo "   security delete-generic-password -a \"$KEYCHAIN_ACCOUNT\" -s \"$KEYCHAIN_SERVICE\""
            echo "   security add-generic-password -a \"$KEYCHAIN_ACCOUNT\" -s \"$KEYCHAIN_SERVICE\" -w"
        fi
    fi
}

# Function to prompt for password
prompt_for_password() {
    echo -n "Enter your SSH password for $REMOTE_USER@$REMOTE_HOST: "
    read -s PASSWORD
    echo
    
    # Test the password
    if ! test_ssh_connection; then
        echo "❌ SSH connection failed. Please check your password and try again."
        exit 1
    fi
}

# Function to test SSH connection
test_ssh_connection() {
    echo "🔑 Testing SSH connection..."
    
    # Check if sshpass is available
    if ! command -v sshpass &> /dev/null; then
        echo "❌ sshpass is not installed. Please install it:"
        echo "   On macOS: brew install sshpass"
        echo "   On Ubuntu/Debian: sudo apt-get install sshpass"
        return 1
    fi
    
    if sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 $REMOTE_USER@$REMOTE_HOST "echo 'SSH connection successful'" >/dev/null 2>&1; then
        echo "✅ SSH connection test successful."
        return 0
    else
        return 1
    fi
}

# Function to run SSH commands with password
run_ssh() {
    sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST "$1"
}

# Function to run SCP with password
run_scp() {
    sshpass -p "$PASSWORD" scp -o StrictHostKeyChecking=no "$@"
}

# Function to follow logs
follow_logs() {
    echo "📋 Attaching to container logs..."
    echo "💡 Press Ctrl+C to exit log following"
    echo ""
    
    # Stream logs reliably without relying on interactive TTY and with robust compose detection
    sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no $REMOTE_USER@$REMOTE_HOST '
        set -e
        cd "'$DEPLOY_PATH'"
        if docker compose version >/dev/null 2>&1; then
            docker compose logs --follow app | cat
        elif command -v docker-compose >/dev/null 2>&1; then
            docker-compose logs --follow app | cat
        else
            echo "❌ Neither docker compose nor docker-compose is available; attempting docker logs fallback" >&2
            CID=$(docker ps -q --filter name=app | head -n1)
            if [ -n "$CID" ]; then
                docker logs -f "$CID" | cat
            else
                echo "❌ Could not find a running container for 'app'" >&2
                exit 1
            fi
        fi'
}



# Function to build and push Docker image
build_and_push() {
    echo "🔨 Building Docker image..."
    
    # Build the image
    if ! docker build -t $IMAGE_NAME:$IMAGE_TAG .; then
        echo "❌ Docker build failed. Aborting deployment."
        exit 1
    fi
    
    echo "🏷️  Tagging image for registry at $REGISTRY_FULL..."
    docker tag "$IMAGE_NAME:$IMAGE_TAG" "$FULL_IMAGE_NAME"

    echo "⬆️  Pushing image to registry..."
    if ! docker push "$FULL_IMAGE_NAME"; then
        echo "❌ Docker push failed. If using HTTP registry, configure Docker daemon with:"
        echo "  \"insecure-registries\": [\"$REGISTRY_FULL\"]"
        echo "in /etc/docker/daemon.json or Docker Desktop settings"
        exit 1
    fi

    echo "✅ Build and push completed successfully!"
}

# Validate configuration
validate_config() {
    if [ -z "$REMOTE_HOST" ]; then
        echo "❌ Error: REMOTE_HOST not set in .env file"
        echo "Please set REMOTE_HOST=your.server.ip.address in .env"
        echo ""
        echo "Example .env file:"
        echo "REMOTE_HOST=192.168.1.100"
        echo "REMOTE_USER=ubuntu"
        echo "DEPLOY_PATH=/home/ubuntu/language-ai-app"
        echo "REGISTRY_HOST=your-registry.com"
        echo "IMAGE_NAME=language-ai-app"
        echo "IMAGE_TAG=latest"
        echo "DEPLOY_PORT=3000"
        exit 1
    fi
    
    if [ -z "$REGISTRY_HOST" ]; then
        echo "❌ Error: REGISTRY_HOST is required for remote deployment, including --deploy-only."
        echo "Set REGISTRY_HOST in .env. This script deploys a published registry image."
        exit 1
    fi
    REGISTRY_FULL="$REGISTRY_HOST:$REGISTRY_PORT"
    FULL_IMAGE_NAME="$REGISTRY_FULL/$IMAGE_NAME:$IMAGE_TAG"

    echo "📋 Deployment Configuration:"
    echo "   Host: $REMOTE_HOST"
    echo "   User: $REMOTE_USER"
    echo "   Path: $DEPLOY_PATH"
    echo "   Port: $DEPLOY_PORT"
    echo "   Image: $FULL_IMAGE_NAME"
    echo "   Cache dir (remote): $CACHE_HOST_DIR"
    echo ""
}

# Parse command line arguments
parse_args "$@"

echo "🚀 Starting LanguageAIApp deployment process..."

# Validate configuration
validate_config

# Get password from keychain or prompt
get_password

# Build and push Docker image unless deploy-only flag is set
if [ "$DEPLOY_ONLY" = false ]; then
    build_and_push
else
    echo "⏩ Skipping build and push (deploy-only mode)"
fi

echo "📋 Deploying LanguageAIApp to $REMOTE_USER@$REMOTE_HOST..."

# Copy deployment files to remote server
echo "📦 Copying deployment files to remote server..."
run_ssh "mkdir -p $DEPLOY_PATH"
run_scp docker-compose.yml .env $REMOTE_USER@$REMOTE_HOST:$DEPLOY_PATH/

echo "🔄 Running deployment on remote server..."
sshpass -p "$PASSWORD" ssh -o StrictHostKeyChecking=no "$REMOTE_USER@$REMOTE_HOST" bash -s -- "$DEPLOY_PATH" "$CACHE_HOST_DIR" "$DEPLOY_PORT" "$FULL_IMAGE_NAME" <<'REMOTE_SCRIPT'
set -e
DEPLOY_PATH="$1"
CACHE_HOST_DIR="$2"
DEPLOY_PORT="$3"

cd "$DEPLOY_PATH"

set -a
[ -f .env ] && . ./.env
set +a
# Select the same published image in normal and --deploy-only runs.
export APP_IMAGE="$4"

echo "📁 Setting up LanguageAIApp deployment..."

sudo mkdir -p "$CACHE_HOST_DIR"
sudo install -d -m 700 -o 1000 -g 1000 "$CACHE_HOST_DIR/auth" "$CACHE_HOST_DIR/cache"
echo "📁 Ensured persistent cache directory exists at $CACHE_HOST_DIR"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "❌ Error: Neither 'docker compose' nor 'docker-compose' found on remote server"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "❌ Error: Docker is not running on remote server"
  exit 1
fi

echo "⬇️  Pulling latest image..."
$COMPOSE_CMD pull

echo "▶️  Starting services..."
$COMPOSE_CMD up -d --no-build --remove-orphans

echo "📊 Services status:"
$COMPOSE_CMD ps
REMOTE_SCRIPT

echo ""
echo "✅ Deployment completed successfully!"
echo "🖥️  Application is now running on your server at $REMOTE_HOST"

# Follow logs if requested
if [ "$FOLLOW_LOGS" = true ]; then
    echo ""
    follow_logs
else
    # Clear password from memory
    PASSWORD=""
    echo "💡 To follow logs, run: $0 --follow-logs"
fi
