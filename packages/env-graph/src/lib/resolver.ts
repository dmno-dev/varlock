
export type ConfigValue =
  undefined |
  string | number | boolean |
  { [key: string]: ConfigValue } |
  Array<ConfigValue>;



type ResolverFunctionArgs = Array<any> | Record<string, any>;
export type ResolverDefinition = (args: ResolverFunctionArgs) => {
  icon: string;
  label: string;
  resolve: (ctx: any) => Promise<ConfigValue>;
};
