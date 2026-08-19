declare module "*.jsx" {
  const Component: React.ComponentType<Record<string, unknown>>;
  export default Component;
}

declare module "*.js";
