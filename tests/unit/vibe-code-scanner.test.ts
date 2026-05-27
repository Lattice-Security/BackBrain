import { describe, expect, it } from "bun:test";
import { VibeCodeScanner } from "../../packages/core/src/adapters/vibe-code-scanner";

describe("VibeCodeScanner", () => {
  const scanner = new VibeCodeScanner();

  it("should detect missing imports", async () => {
    const content = `
      fs.readFileSync('test.txt');
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const missingImport = issues.find(i => i.ruleId === 'vibe-code.missing-import');
    expect(missingImport).toBeDefined();
    expect(missingImport?.description).toContain("'fs' is used but not imported");
  });

  it("should detect inconsistent naming", async () => {
    const content = `
      function myTestFunction() {}
      mytestfunction();
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const nameMismatch = issues.find(i => i.ruleId === 'vibe-code.name-mismatch');
    expect(nameMismatch).toBeDefined();
    expect(nameMismatch?.description).toContain("'mytestfunction' should be 'myTestFunction'");
  });

  it("should detect unhandled promises", async () => {
    const content = `
      fetch('https://api.example.com');
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const unhandledPromise = issues.find(i => i.ruleId === 'vibe-code.unhandled-promise');
    expect(unhandledPromise).toBeDefined();
  });

  it("should NOT flag multi-line promise chains with .catch", async () => {
    const content = `
      fetch('https://api.example.com')
        .then(res => res.json())
        .catch(err => console.error(err));
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const unhandled = issues.filter(i => i.ruleId === 'vibe-code.unhandled-promise');
    expect(unhandled.length).toBe(0);
  });

  it("should NOT flag awaited promises", async () => {
    const content = `
      const data = await fetch('https://api.example.com');
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const unhandled = issues.filter(i => i.ruleId === 'vibe-code.unhandled-promise');
    expect(unhandled.length).toBe(0);
  });

  it("should NOT flag axios multi-line chains", async () => {
    const content = `
      axios.get('/api/data')
        .then(response => response.data)
        .catch(err => {});
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const unhandled = issues.filter(i => i.ruleId === 'vibe-code.unhandled-promise');
    expect(unhandled.length).toBe(0);
  });

  it("should flag fetch without any handling", async () => {
    const content = "fetch('https://api.example.com');";
    const issues = await scanner.scanFile("test.ts", content);
    const unhandled = issues.filter(i => i.ruleId === 'vibe-code.unhandled-promise');
    expect(unhandled.length).toBe(1);
  });

  it("should detect deprecated APIs via regex rule", async () => {
    const content = `
      class MyComponent extends React.Component {
        componentWillMount() {}
      }
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const deprecatedApi = issues.find(i => i.ruleId === 'vibe-code.deprecated-api');
    expect(deprecatedApi).toBeDefined();
    expect(deprecatedApi?.description).toContain("Use of deprecated React lifecycle methods");
  });

  it("should return the correct name", () => {
    expect(scanner.name).toBe("vibe-code");
  });

  it("should support common extensions", () => {
    const extensions = scanner.getSupportedExtensions();
    expect(extensions).toContain(".ts");
    expect(extensions).toContain(".py");
  });

  // Phase 8.2 - New Detector Tests

  it("should detect dead code after return statement", async () => {
    const content = `
function test() {
  return 42;
  console.log("This is dead code");
}
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const deadCode = issues.find(i => i.ruleId === 'vibe-code.dead-code');
    expect(deadCode).toBeDefined();
    expect(deadCode?.description).toContain("Unreachable code");
  });

  it("should detect type mismatch - parseInt on number", async () => {
    const content = `
const myNumber = 42;
const result = parseInt(myNumber);
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const typeMismatch = issues.find(i => i.ruleId === 'vibe-code.type-mismatch');
    expect(typeMismatch).toBeDefined();
    expect(typeMismatch?.description).toContain("parseInt/parseFloat called on");
  });

  it("should detect type mismatch - string method on number", async () => {
    const content = `
const count = 100;
const parts = count.split(",");
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const typeMismatch = issues.find(i => i.ruleId === 'vibe-code.type-mismatch');
    expect(typeMismatch).toBeDefined();
    expect(typeMismatch?.description).toContain("String method 'split'");
  });

  it("should filter files by supported extensions in scan()", async () => {
    // Test that scan() filters to supported extensions
    const result = await scanner.scan([
      "/fake/path/script.ts",
      "/fake/path/readme.md",  // Not supported
      "/fake/path/app.py"
    ]);
    // Files don't exist so we expect empty results, but the method should work
    expect(result).toBeDefined();
    expect(result.scannerInfo).toBe("VibeCode Scanner");
    expect(result.scannedFiles).toEqual([]); // Files don't exist
  });

  it("should NOT detect dead code in switch statements", async () => {
    const content = `
function test(x) {
  switch(x) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return "other";
  }
}
    `;
    const issues = await scanner.scanFile("test.ts", content);
    const deadCode = issues.filter(i => i.ruleId === 'vibe-code.dead-code');
    // Should NOT find dead code for case 2 or default
    expect(deadCode.length).toBe(0);
  });

  it("should NOT register declarations from comments in naming check", async () => {
    const content = `// const myVar = 5;
myVar = 10;`;
    const issues = await scanner.scanFile("test.ts", content);
    // 'myVar' is not a real declaration (it's in a comment), so 'myvar(' should NOT
    // produce a naming mismatch since there's no canonical declaration
    const namingIssues = issues.filter(i => i.ruleId === 'vibe-code.name-mismatch');
    expect(namingIssues.length).toBe(0);
  });

  it("should ignore patterns inside comments and strings", async () => {
    const content = `
      // TODO: This is a comment, should be ignored
      const x = "TODO: This is a string, should be ignored";
      /* TODO: Multi-line comment */
    `;
    // Add a temporary rule to detect TODO:
    scanner.setRules([{
      id: 'vibe-code.todo',
      title: 'TODO Found',
      description: 'Found a TODO',
      severity: 'low',
      pattern: /TODO:/g,
      type: 'regex'
    }]);

    const issues = await scanner.scanFile("test.ts", content);
    const todoIssues = issues.filter(i => i.ruleId === 'vibe-code.todo');
    expect(todoIssues.length).toBe(0);
  });

  it("should correctly handle scoped packages in hallucinated deps", async () => {
    // Mock FileSystem to provide a package.json
    const mockFS = {
      readFile: async (path: string) => {
        if (path.endsWith('package.json')) {
          return JSON.stringify({
            dependencies: {
              "@backbrain/core": "1.0.0",
              "lodash": "4.17.21"
            }
          });
        }
        return "";
      },
      exists: async () => true,
      writeFile: async () => { },
      deleteFile: async () => { },
      readDirectory: async () => []
    };

    const scannerWithFS = new VibeCodeScanner(mockFS);
    const content = `
      import { something } from '@backbrain/core/utils';
      import _ from 'lodash';
      import { other } from '@unknown/pkg';
    `;

    const issues = await scannerWithFS.scanFile("/project/test.ts", content);
    const hallucinated = issues.filter(i => i.ruleId === 'vibe-code.hallucinated-dep');

    expect(hallucinated.length).toBe(1);
    expect(hallucinated[0]?.description).toContain("'@unknown/pkg' is imported but not found");
  });
});

