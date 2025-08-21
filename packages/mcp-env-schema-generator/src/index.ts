/**
 * MCP Server for Environment Schema Generation
 * Generates environment variable schemas from package documentation
 * Enhanced with AI SDK for intelligent schema generation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

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

interface AIProvider {
  name: string;
  model: any;
  apiKey: string;
}

class EnvSchemaGenerator {
  private aiProvider: AIProvider | null = null;

  constructor() {
    this.detectAIProvider();
  }

  /**
   * Auto-detect available AI provider from environment variables
   */
  private detectAIProvider(): void {
    // Check for OpenAI
    if (process.env.OPENAI_API_KEY) {
      this.aiProvider = {
        name: 'openai',
        model: openai('gpt-4-turbo-preview'),
        apiKey: process.env.OPENAI_API_KEY,
      };
      console.error('Detected OpenAI API key, using GPT-4 for enhanced schema generation');
      return;
    }

    // Check for Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      this.aiProvider = {
        name: 'anthropic',
        model: anthropic('claude-3-opus-20240229'),
        apiKey: process.env.ANTHROPIC_API_KEY,
      };
      console.error('Detected Anthropic API key, using Claude 3 for enhanced schema generation');
      return;
    }

    // Check for Google Gemini
    if (process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY) {
      this.aiProvider = {
        name: 'google',
        model: google('gemini-1.5-pro'),
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY || '',
      };
      console.error('Detected Google AI API key, using Gemini for enhanced schema generation');
      return;
    }

    console.error('No AI API keys detected. Using regex-based parsing only.');
  }

  /**
   * Search for environment variables in documentation with optional AI enhancement
   */
  async searchEnvVars(
    packageName: string,
    searchTerms: string[] = [],
    useAI: boolean = true
  ): Promise<EnvVariable[]> {
    const envVars: EnvVariable[] = [];
    
    try {
      // Fetch documentation from multiple sources
      const documentation = await this.fetchDocumentation(packageName);
      
      if (!documentation) {
        return [];
      }

      // First, use regex-based parsing
      const regexVars = this.parseEnvVarsFromContent(documentation, searchTerms);
      envVars.push(...regexVars);

      // If AI is available and enabled, enhance with AI
      if (useAI && this.aiProvider && documentation) {
        try {
          const aiVars = await this.enhanceWithAI(packageName, documentation, regexVars);
          
          // Merge AI results with regex results
          for (const aiVar of aiVars) {
            const existing = envVars.find(v => v.name === aiVar.name);
            if (existing) {
              // Enhance existing variable with AI insights
              existing.description = aiVar.description || existing.description;
              existing.required = aiVar.required ?? existing.required;
              existing.secret = aiVar.secret ?? existing.secret;
              existing.pattern = aiVar.pattern || existing.pattern;
              existing.example = aiVar.example || existing.example;
              existing.defaultValue = aiVar.defaultValue || existing.defaultValue;
              existing.type = aiVar.type || existing.type;
            } else {
              // Add new variable discovered by AI
              envVars.push(aiVar);
            }
          }
        } catch (error) {
          console.error('AI enhancement failed, using regex results only:', error);
        }
      }

      // Deduplicate and clean up
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
   * Fetch documentation from multiple sources
   */
  private async fetchDocumentation(packageName: string): Promise<string | null> {
    const sources = [
      `https://www.npmjs.com/package/${packageName}`,
      `https://raw.githubusercontent.com/${packageName}/main/README.md`,
      `https://raw.githubusercontent.com/${packageName}/master/README.md`,
      `https://raw.githubusercontent.com/${packageName}/main/docs/configuration.md`,
      `https://raw.githubusercontent.com/${packageName}/main/.env.example`,
    ];

    let allContent = '';

    for (const url of sources) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const content = await response.text();
          allContent += `\n\n--- Source: ${url} ---\n\n${content}`;
        }
      } catch {
        // Continue to next source
      }
    }

    return allContent || null;
  }

  /**
   * Enhance environment variables with AI
   */
  private async enhanceWithAI(
    packageName: string,
    documentation: string,
    existingVars: EnvVariable[]
  ): Promise<EnvVariable[]> {
    if (!this.aiProvider) {
      return [];
    }

    const prompt = `You are an expert at analyzing package documentation to identify environment variables.

Package: ${packageName}

Documentation (truncated to 10000 chars):
${documentation.substring(0, 10000)}

Existing variables found by regex:
${existingVars.map(v => `- ${v.name}: ${v.description || 'no description'}`).join('\n')}

Please analyze the documentation and:
1. Identify ALL environment variables mentioned
2. Determine if each is required or optional
3. Identify if it contains sensitive data (secret)
4. Provide a clear description
5. Suggest a regex pattern for validation if applicable
6. Provide a realistic example value
7. Identify the type (string, number, boolean, array, json)

Return a JSON array of environment variables with this structure:
[
  {
    "name": "ENV_VAR_NAME",
    "description": "Clear description",
    "required": true/false,
    "secret": true/false,
    "pattern": "^regex-pattern$" or null,
    "example": "example-value" or null,
    "defaultValue": "default" or null,
    "type": "string|number|boolean|array|json"
  }
]

IMPORTANT: Only return valid JSON array, no other text.`;

    try {
      const { text } = await generateText({
        model: this.aiProvider.model,
        prompt,
        temperature: 0.3,
        maxTokens: 2000,
      });

      // Parse AI response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const aiVars = JSON.parse(jsonMatch[0]) as EnvVariable[];
        return aiVars.filter(v => v.name && /^[A-Z_][A-Z0-9_]*$/.test(v.name));
      }
    } catch (error) {
      console.error('AI parsing error:', error);
    }

    return [];
  }

  /**
   * Parse environment variables from text content using regex
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
    if (this.aiProvider) {
      lines.push(`# @generated-with AI-enhanced analysis (${this.aiProvider.name})`);
    }
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
        if (variable.defaultValue) {
          lines.push(`# @default ${variable.defaultValue}`);
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
        if (variable.pattern) {
          lines.push(`# @pattern ${variable.pattern}`);
        }
        if (variable.example) {
          lines.push(`# @example ${variable.example}`);
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
        if (variable.pattern) {
          lines.push(`# @pattern ${variable.pattern}`);
        }
        if (variable.example) {
          lines.push(`# @example ${variable.example}`);
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
    version: '0.2.0',
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
        description: 'Generate an environment schema from a package name (AI-enhanced)',
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
            useAI: {
              type: 'boolean',
              description: 'Use AI to enhance schema generation (auto-detects available API keys)',
              default: true,
            },
          },
          required: ['packageName'],
        },
      },
      {
        name: 'search_env_vars',
        description: 'Search for environment variables in package documentation (AI-enhanced)',
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
            useAI: {
              type: 'boolean',
              description: 'Use AI to enhance search (auto-detects available API keys)',
              default: true,
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
      const { packageName, version, framework, useAI = true } = args as any;
      
      // Search for environment variables
      const variables = await generator.searchEnvVars(packageName, [], useAI);
      
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
      const { packageName, searchTerms, useAI = true } = args as any;
      
      const variables = await generator.searchEnvVars(packageName, searchTerms || [], useAI);
      
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
  console.error('MCP Server started (v0.2.0 with AI enhancement)');
}

main().catch(console.error);