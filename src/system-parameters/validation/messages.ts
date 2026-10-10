export const PARAMETER_KEY_FORMAT_ERROR =
  'Key must be a lowercase kebab-case slug of at most 64 characters.'

export const PARAMETER_KEY_UNIQUE_ERROR = 'Key must be unique.'

export const PARAMETER_CATEGORY_FORMAT_ERROR =
  'Category must be a lowercase kebab-case slug of at most 64 characters.'

export const PARAMETER_SECRET_KEY_ERROR =
  'Keys that look like secrets cannot be stored as parameters. Use a Worker secret instead.'

export const PARAMETER_VALUE_REQUIRED_ERROR = 'A value is required.'

export const PARAMETER_STRING_VALUE_ERROR = 'Value must be a string.'

export const PARAMETER_STRING_LENGTH_ERROR = 'String value exceeds the maximum length.'

export const PARAMETER_NUMBER_VALUE_ERROR = 'Value must be a finite number.'

export const PARAMETER_BOOLEAN_VALUE_ERROR = 'Value must be true or false.'

export const PARAMETER_JSON_SYNTAX_ERROR = 'Value is not valid JSON.'

export const PARAMETER_JSON_SHAPE_ERROR =
  'JSON parameters must be a JSON object or array, not a string, number, boolean, or null.'

export const PARAMETER_JSON_SIZE_ERROR = 'JSON value exceeds the maximum size.'

export const PARAMETER_JSON_DEPTH_ERROR = 'JSON value exceeds the maximum nesting depth.'

export const PARAMETER_VALUE_TYPE_ERROR = 'Value type must be string, number, boolean, or json.'
