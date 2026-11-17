variable "env" {
  description = "Deployment environment, used in names and tags."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be dev, staging or prod."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "owner" {
  description = "Owner tag."
  type        = string
  default     = "prediction-radar"
}

variable "lambda_zip_path" {
  description = "Bundled handler (esbuild output, zipped). Not built by this slice."
  type        = string
  default     = "build/digest-handler.zip"
}

variable "timeout_seconds" {
  description = "Lambda timeout. The handler enforces its own, shorter, model deadline."
  type        = number
  default     = 120
}
