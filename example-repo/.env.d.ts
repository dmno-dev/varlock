// not auto-generated yet, but the plan is this will be.
// just testing out methods of injecting type info into your codebase

type CoercedEnvSchema = {
  /**
   * **ITEM1**  
   * This is a test item  
   * ![icon](data:image/svg+xml;utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%20viewBox%3D%220%200%2032%2032%22%3E%3Cpath%20fill%3D%22%23808080%22%20d%3D%22M29%2022h-5a2.003%202.003%200%200%201-2-2v-6a2%202%200%200%201%202-2h5v2h-5v6h5zM18%2012h-4V8h-2v14h6a2.003%202.003%200%200%200%202-2v-6a2%202%200%200%200-2-2m-4%208v-6h4v6zm-6-8H3v2h5v2H4a2%202%200%200%200-2%202v2a2%202%200%200%200%202%202h6v-8a2%202%200%200%200-2-2m0%208H4v-2h4z%22%2F%3E%3C%2Fsvg%3E)   
   */
  readonly SENSITIVE_ITEM: string;
}

interface StringEnvSchema = {
  /**
   * **ITEM1**  
   * This is a test item  
   * ![icon](data:image/svg+xml;utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2220%22%20height%3D%2220%22%20viewBox%3D%220%200%2032%2032%22%3E%3Cpath%20fill%3D%22%23808080%22%20d%3D%22M29%2022h-5a2.003%202.003%200%200%201-2-2v-6a2%202%200%200%201%202-2h5v2h-5v6h5zM18%2012h-4V8h-2v14h6a2.003%202.003%200%200%200%202-2v-6a2%202%200%200%200-2-2m-4%208v-6h4v6zm-6-8H3v2h5v2H4a2%202%200%200%200-2%202v2a2%202%200%200%200%202%202h6v-8a2%202%200%200%200-2-2m0%208H4v-2h4z%22%2F%3E%3C%2Fsvg%3E)   
   */
  readonly SENSITIVE_ITEM: string;
}

declare module 'varlock' {
  export const ENV: CoercedEnvSchema;
}

