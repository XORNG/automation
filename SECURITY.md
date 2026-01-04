# Security Policy

## Our Commitment

XORNG is committed to ensuring the security of our agentic coding framework and protecting our users. We take security vulnerabilities seriously and appreciate the community's efforts in responsibly disclosing any issues.

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We appreciate your help in keeping XORNG secure. If you discover a security vulnerability, please follow these guidelines:

### How to Report

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. Send a detailed report to: security@xorng.dev (or create a private security advisory)
3. Use GitHub's private vulnerability reporting feature if available

### What to Include

Please provide the following information in your report:

- **Description**: A clear description of the vulnerability
- **Impact**: Potential impact and severity assessment
- **Reproduction Steps**: Detailed steps to reproduce the issue
- **Affected Components**: Which repositories/components are affected
- **Proof of Concept**: If possible, include a minimal PoC
- **Suggested Fix**: Any suggestions for remediation (optional)

### Response Timeline

- **Acknowledgment**: Within 48 hours of receiving your report
- **Initial Assessment**: Within 5 business days
- **Resolution Timeline**: Depends on severity
  - Critical: 7 days
  - High: 14 days
  - Medium: 30 days
  - Low: 60 days

### Disclosure Policy

- We follow a coordinated disclosure process
- We will work with you to understand and resolve the issue
- We will credit reporters in our security advisories (unless you prefer anonymity)
- We request a 90-day disclosure window before public disclosure

## Security Measures

### Automated Security Scanning

All XORNG repositories employ comprehensive security scanning:

- **CodeQL Analysis**: Static application security testing (SAST) for JavaScript/TypeScript
- **Dependabot**: Automated dependency updates and vulnerability alerts
- **npm Audit**: Regular security audits of npm dependencies
- **Secret Scanning**: Detection of accidentally committed secrets (TruffleHog)
- **Semgrep**: Additional SAST rules for common vulnerabilities
- **Trivy**: Container image vulnerability scanning (for Docker-based components)

### Development Practices

We follow security best practices in our development process:

- Code review requirements for all changes
- Dependency pinning and regular updates
- Principle of least privilege for all components
- Secure defaults for all configurations
- Input validation and sanitization
- Secure handling of API keys and secrets

### Sub-Agent Security (Validators, Knowledge, Tasks)

XORNG sub-agents run in isolated Docker containers with:

- Minimal base images
- No root user access
- Network isolation
- Resource limits
- Read-only filesystems where possible

## Security Recommendations for Users

### Configuration

1. **API Keys**: Never commit API keys or secrets to repositories
2. **Environment Variables**: Use secure environment variable management
3. **Network Security**: Run XORNG behind proper firewall rules
4. **Access Control**: Implement proper authentication for any exposed endpoints

### Docker Security

When running XORNG containers:

```yaml
# Example secure Docker Compose configuration
services:
  xorng-agent:
    security_opt:
      - no-new-privileges:true
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
```

### Dependency Management

- Regularly update dependencies using Dependabot PRs
- Review dependency changes before merging
- Monitor security advisories for your dependencies

## Security Features

### For Validators

The validator sub-agents include built-in security scanning capabilities:

- **validator-security**: Dedicated security analysis for code
- **validator-code-review**: Code quality and security patterns

### For Knowledge Bases

- Secure storage of best practices and documentation
- Sandboxed execution for any code examples
- Validation of external data sources

### For Task Agents

- Isolated execution environments
- Limited filesystem access
- Controlled network access
- Audit logging of all operations

## Bug Bounty

Currently, XORNG does not have a formal bug bounty program. However, we greatly appreciate security research and will:

- Acknowledge your contribution publicly (if desired)
- Consider providing compensation for significant findings
- Work with you on coordinated disclosure

## Contact

- **Security Issues**: security@xorng.dev
- **General Questions**: https://github.com/XORNG/discussions
- **Documentation**: https://github.com/XORNG/documentation

## Updates

This security policy was last updated: January 2026

We review and update this policy regularly to reflect changes in our security practices and the threat landscape.
