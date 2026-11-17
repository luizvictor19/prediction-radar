# Minimal root for the digest step: one table, one function, one role.
# Checked with `terraform validate` only. Nothing here has been applied.

terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project = "prediction-radar"
      env     = var.env
      owner   = var.owner
    }
  }
}

locals {
  name = "radar-digest-${var.env}"
}

# One partition per rule text, one item per reading:
# PK = RULE#<sha256>, SK = READING#<iso timestamp>.
resource "aws_dynamodb_table" "digests" {
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }
}

resource "aws_cloudwatch_log_group" "digest" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 14
}

data "aws_iam_policy_document" "assume_lambda" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "digest" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.assume_lambda.json
}

# Least privilege: write and read items in this one table, write logs to this
# one log group. No Scan, no Delete, no other table, no wildcard resource.
data "aws_iam_policy_document" "digest" {
  statement {
    sid       = "DigestRecords"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem"]
    resources = [aws_dynamodb_table.digests.arn]
  }

  statement {
    sid       = "OwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.digest.arn}:*"]
  }
}

resource "aws_iam_role_policy" "digest" {
  name   = local.name
  role   = aws_iam_role.digest.id
  policy = data.aws_iam_policy_document.digest.json
}

resource "aws_lambda_function" "digest" {
  function_name = local.name
  role          = aws_iam_role.digest.arn
  runtime       = "nodejs22.x"
  handler       = "index.handler"
  filename      = var.lambda_zip_path
  timeout       = var.timeout_seconds
  memory_size   = 512

  # A cap on concurrent invocations is also a cap on model spend per minute.
  reserved_concurrent_executions = 4

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.digests.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.digest]
}
