/** Payload ships this CSS entry without a type declaration. */
declare module '@payloadcms/next/css'

declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
