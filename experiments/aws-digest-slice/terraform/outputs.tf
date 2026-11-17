output "table_name" {
  value = aws_dynamodb_table.digests.name
}

output "function_name" {
  value = aws_lambda_function.digest.function_name
}

output "role_arn" {
  value = aws_iam_role.digest.arn
}
