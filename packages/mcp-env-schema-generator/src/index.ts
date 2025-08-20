/**
 * MCP Server for Environment Schema Generation
 * Generates environment variable schemas from package documentation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

interface EnvVariable {
  name: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  pattern?: string;
  example?: string;
  defaultValue?: string;
  type?: 'string' | 'number' | 'boolean' | 'array' | 'json';
}

class EnvSchemaGenerator {
  /**
   * Search for environment variables in documentation
   */
  async searchEnvVars(packageName: string, searchTerms: string[] = []): Promise<EnvVariable[]> {
    const envVars: EnvVariable[] = [];
    
    try {
      // Try multiple documentation sources
      const sources = [
        `https://www.npmjs.com/package/${packageName}`,
        `https://github.com/search?q=repo:${packageName}+env+OR+environment+OR+config`,
        `https://raw.githubusercontent.com/${packageName}/main/README.md`,
        `https://raw.githubusercontent.com/${packageName}/master/README.md`,
      ];

      for (const url of sources) {
        try {
          const response = await fetch(url);
          if (!response.ok) continue;
          
          const content = await response.text();
          
          // Parse environment variables from content
          const vars = this.parseEnvVarsFromContent(content, searchTerms);
          envVars.push(...vars);
        } catch {
          // Continue to next source
        }
      }

      // Deduplicate by name
      const uniqueVars = new Map<string, EnvVariable>();
      for (const v of envVars) {
        if (!uniqueVars.has(v.name) || (v.description && !uniqueVars.get(v.name)?.description)) {
          uniqueVars.set(v.name, v);
        }
      }

      return Array.from(uniqueVars.values());
    } catch (error) {
      console.error('Error searching env vars:', error);
      return [];
    }
  }

  /**
   * Parse environment variables from text content
   */
  private parseEnvVarsFromContent(content: string, searchTerms: string[]): EnvVariable[] {
    const envVars: EnvVariable[] = [];
    
    // Common patterns for environment variables
    const patterns = [
      // Markdown table format
      /\|?\s*([A-Z_][A-Z0-9_]*)\s*\|([^|]*)\|([^|]*)\|?/gm,
      // Code blocks with env vars
      /^([A-Z_][A-Z0-9_]*)=(.*)$/gm,
      // Documentation format: ENV_VAR - description
      /^([A-Z_][A-Z0-9_]*)\s*[-:]\s*(.+)$/gm,
      // process.env.SOMETHING references
      /process\.env\.([A-Z_][A-Z0-9_]*)/g,
      // Environment variable in headers
      /^#+\s*([A-Z_][A-Z0-9_]*)\s*$/gm,
    ];

    // Search for API keys and tokens
    const secretPatterns = [
      /([A-Z_]*(?:API|SECRET|TOKEN|KEY|PASSWORD|PRIVATE|AUTH|CREDENTIAL)[A-Z_]*)/g,
      /([A-Z_]*(?:DSN|URL|URI|ENDPOINT|HOST|PORT)[A-Z_]*)/g,
    ];

    // Extract variables using patterns
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const varName = match[1];
        const description = match[2]?.trim();
        
        if (varName && varName.length > 2) {
          envVars.push({
            name: varName,
            description: description || undefined,
            required: content.toLowerCase().includes(`${varName.toLowerCase()} is required`) ||
                     content.toLowerCase().includes(`required: ${varName.toLowerCase()}`),
            secret: this.isSecretVariable(varName),
            type: this.inferType(varName, content),
          });
        }
      }
    }

    // Search for specific terms
    for (const term of searchTerms) {
      const termPattern = new RegExp(`([A-Z_]*${term.toUpperCase()}[A-Z_]*)`, 'g');
      let match;
      while ((match = termPattern.exec(content)) !== null) {
        const varName = match[1];
        if (varName && varName.length > 2 && /^[A-Z_][A-Z0-9_]*$/.test(varName)) {
          envVars.push({
            name: varName,
            secret: this.isSecretVariable(varName),
            type: this.inferType(varName, content),
          });
        }
      }
    }

    return envVars;
  }

  /**
   * Check if a variable name suggests it's a secret
   */
  private isSecretVariable(name: string): boolean {
    const secretKeywords = [
      'SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'PRIVATE',
      'AUTH', 'CREDENTIAL', 'API_KEY', 'ACCESS', 'REFRESH'
    ];
    
    return secretKeywords.some(keyword => 
      name.toUpperCase().includes(keyword)
    );
  }

  /**
   * Infer the type of an environment variable
   */
  private inferType(name: string, content: string): EnvVariable['type'] {
    const nameLower = name.toLowerCase();
    
    // Boolean indicators
    if (nameLower.includes('enable') || nameLower.includes('disable') ||
        nameLower.includes('debug') || nameLower.includes('verbose') ||
        nameLower.includes('is_') || nameLower.includes('has_') ||
        nameLower.includes('use_') || nameLower.includes('skip_')) {
      return 'boolean';
    }
    
    // Number indicators
    if (nameLower.includes('port') || nameLower.includes('timeout') ||
        nameLower.includes('limit') || nameLower.includes('count') ||
        nameLower.includes('size') || nameLower.includes('max') ||
        nameLower.includes('min') || nameLower.includes('rate')) {
      return 'number';
    }
    
    // Array indicators
    if (nameLower.includes('list') || nameLower.includes('urls') ||
        nameLower.includes('hosts') || nameLower.includes('domains')) {
      return 'array';
    }
    
    // JSON indicators
    if (nameLower.includes('config') || nameLower.includes('options') ||
        nameLower.includes('settings') || nameLower.includes('json')) {
      return 'json';
    }
    
    return 'string';
  }

  /**
   * Generate a schema from discovered variables
   */
  generateSchema(
    packageName: string,
    variables: EnvVariable[],
    version?: string,
    framework?: string
  ): string {
    const lines: string[] = [];
    
    // Header
    lines.push(`# ${packageName} Environment Variables`);
    lines.push(`# @package ${packageName}`);
    if (version) {
      lines.push(`# @version ${version}`);
    }
    if (framework) {
      lines.push(`# @framework ${framework}`);
    }
    lines.push(`# @url https://www.npmjs.com/package/${packageName}`);
    lines.push('');
    
    // Group variables by type
    const secrets = variables.filter(v => v.secret);
    const required = variables.filter(v => v.required && !v.secret);
    const optional = variables.filter(v => !v.required && !v.secret);
    
    // Add secrets
    if (secrets.length > 0) {
      lines.push('# === Security Sensitive ===');
      lines.push('');
      for (const variable of secrets) {
        lines.push(`# @${variable.required ? 'required' : 'optional'} @secret`);
        if (variable.description) {
          lines.push(`# @desc ${variable.description}`);
        }
        if (variable.type && variable.type !== 'string') {
          lines.push(`# @${variable.type}`);
        }
        if (variable.pattern) {
          lines.push(`# @pattern ${variable.pattern}`);
        }
        if (variable.example) {
          lines.push(`# @example ${variable.example}`);
        }
        lines.push(`${variable.name}=`);
        lines.push('');
      }
    }
    
    // Add required variables
    if (required.length > 0) {
      lines.push('# === Required Configuration ===');
      lines.push('');
      for (const variable of required) {
        lines.push('# @required @public');
        if (variable.description) {
          lines.push(`# @desc ${variable.description}`);
        }
        if (variable.type && variable.type !== 'string') {
          lines.push(`# @${variable.type}`);
        }
        if (variable.defaultValue) {
          lines.push(`# @default ${variable.defaultValue}`);
        }
        lines.push(`${variable.name}=`);
        lines.push('');
      }
    }
    
    // Add optional variables
    if (optional.length > 0) {
      lines.push('# === Optional Configuration ===');
      lines.push('');
      for (const variable of optional) {
        lines.push('# @optional @public');
        if (variable.description) {
          lines.push(`# @desc ${variable.description}`);
        }
        if (variable.type && variable.type !== 'string') {
          lines.push(`# @${variable.type}`);
        }
        if (variable.defaultValue) {
          lines.push(`# @default ${variable.defaultValue}`);
        }
        lines.push(`${variable.name}=`);
        lines.push('');
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Validate a schema
   */
  validateSchema(schema: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const lines = schema.split('\n');
    const variables = new Set<string>();
    
    let currentDecorators: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Skip empty lines and dividers
      if (!line || line.match(/^#\s*={3,}/) || line.match(/^#\s*-{3,}/)) {
        continue;
      }
      
      // Decorator line
      if (line.startsWith('#')) {
        const decorators = line.match(/@(\w+)/g);
        if (decorators) {
          currentDecorators.push(...decorators);
        }
        continue;
      }
      
      // Variable definition
      const varMatch = line.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (varMatch) {
        const varName = varMatch[1];
        
        // Check for duplicates
        if (variables.has(varName)) {
          errors.push(`Line ${i + 1}: Duplicate variable ${varName}`);
        }
        variables.add(varName);
        
        // Check decorators
        const hasRequired = currentDecorators.includes('@required');
        const hasOptional = currentDecorators.includes('@optional');
        const hasSuggested = currentDecorators.includes('@suggested');
        
        const priorities = [hasRequired, hasOptional, hasSuggested].filter(Boolean);
        if (priorities.length > 1) {
          errors.push(`Line ${i + 1}: Variable ${varName} has multiple priority decorators`);
        }
        
        if (priorities.length === 0) {
          errors.push(`Line ${i + 1}: Variable ${varName} missing priority decorator (@required/@optional/@suggested)`);
        }
        
        const hasSecret = currentDecorators.includes('@secret');
        const hasPublic = currentDecorators.includes('@public');
        
        if (hasSecret && hasPublic) {
          errors.push(`Line ${i + 1}: Variable ${varName} cannot be both @secret and @public`);
        }
        
        if (!hasSecret && !hasPublic) {
          errors.push(`Line ${i + 1}: Variable ${varName} missing security decorator (@secret/@public)`);
        }
        
        // Reset decorators for next variable
        currentDecorators = [];
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Initialize MCP server
const server = new Server(
  {
    name: 'env-schema-generator',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const generator = new EnvSchemaGenerator();

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'generate_schema',
        description: 'Generate an environment schema from a package name',
        inputSchema: {
          type: 'object',
          properties: {
            packageName: {
              type: 'string',
              description: 'NPM package name',
            },
            version: {
              type: 'string',
              description: 'Package version (optional)',
            },
            framework: {
              type: 'string',
              description: 'Target framework (optional)',
              enum: ['nextjs', 'vite', 'astro', 'remix', 'nuxt', 'sveltekit'],
            },
          },
          required: ['packageName'],
        },
      },
      {
        name: 'search_env_vars',
        description: 'Search for environment variables in package documentation',
        inputSchema: {
          type: 'object',
          properties: {
            packageName: {
              type: 'string',
              description: 'NPM package name',
            },
            searchTerms: {
              type: 'array',
              items: {
                type: 'string',
              },
              description: 'Additional search terms',
            },
          },
          required: ['packageName'],
        },
      },
      {
        name: 'validate_schema',
        description: 'Validate an environment schema',
        inputSchema: {
          type: 'object',
          properties: {
            schema: {
              type: 'string',
              description: 'Schema content to validate',
            },
          },
          required: ['schema'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'generate_schema': {
      const { packageName, version, framework } = args as any;
      
      // Search for environment variables
      const variables = await generator.searchEnvVars(packageName);
      
      if (variables.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No environment variables found for package "${packageName}". Try searching with specific terms or check the package documentation manually.`,
            },
          ],
        };
      }
      
      // Generate schema
      const schema = generator.generateSchema(packageName, variables, version, framework);
      
      return {
        content: [
          {
            type: 'text',
            text: schema,
          },
        ],
      };
    }

    case 'search_env_vars': {
      const { packageName, searchTerms } = args as any;
      
      const variables = await generator.searchEnvVars(packageName, searchTerms || []);
      
      if (variables.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No environment variables found for package "${packageName}".`,
            },
          ],
        };
      }
      
      const result = variables
        .map(v => `- ${v.name}${v.secret ? ' (secret)' : ''}${v.required ? ' (required)' : ''}${v.description ? `: ${v.description}` : ''}`)
        .join('\n');
      
      return {
        content: [
          {
            type: 'text',
            text: `Found ${variables.length} environment variables:\n\n${result}`,
          },
        ],
      };
    }

    case 'validate_schema': {
      const { schema } = args as any;
      
      const validation = generator.validateSchema(schema);
      
      if (validation.valid) {
        return {
          content: [
            {
              type: 'text',
              text: 'Schema is valid!',
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Schema validation failed:\n\n${validation.errors.join('\n')}`,
            },
          ],
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server started');
}

main().catch(console.error);