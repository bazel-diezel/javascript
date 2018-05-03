const child_process = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const ts = require("typescript");

const [
  nodePath,
  scriptPath,
  installedNpmPackagesDir,
  buildfilePath,
  tsconfigPath,
  joinedRequires,
  joinedInternalDeps,
  joinedSrcs,
  destinationDir
] = process.argv;

const buildfileDir = path.dirname(buildfilePath);
const required = new Set(joinedRequires.split("|"));
const internalDeps = joinedInternalDeps.split("|");
const srcs = joinedSrcs.split("|");

fs.mkdirSync(destinationDir);

if (fs.existsSync(path.join(installedNpmPackagesDir, "node_modules"))) {
  // Find all the packages we depend on indirectly. We'll only include those.
  const analyzedPackageNames = new Set();
  const toAnalyzePackageNames = Array.from(required);
  for (let i = 0; i < toAnalyzePackageNames.length; i++) {
    findPackageDependencies(toAnalyzePackageNames[i]);
  }
  function findPackageDependencies(name) {
    if (!name) {
      // Occurs when there are no dependencies.
      return;
    }
    if (analyzedPackageNames.has(name)) {
      // Already processed.
      return;
    }
    analyzedPackageNames.add(name);
    const packageJsonPath = path.join(
      installedNpmPackagesDir,
      "node_modules",
      name,
      "package.json"
    );
    if (!fs.existsSync(packageJsonPath)) {
      return;
    }
    try {
      const package = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (!package.dependencies) {
        return;
      }
      for (const dependencyName of Object.keys(package.dependencies)) {
        toAnalyzePackageNames.push(dependencyName);
      }
    } catch (e) {
      console.warn(`Could not read package.json for package ${name}.`, e);
      return;
    }
  }

  // Create a symbolic link from node_modules.
  // IMPORTANT: We need to `cd` into the immediate parent directory that will
  // contain the symbolic link, otherwise TypeScript gets confused.
  // I know, weird hack. If you have something better, let me know!
  fs.mkdirSync(path.join(destinationDir, "node_modules"));
  for (const packageName of analyzedPackageNames) {
    if (packageName.indexOf("/") !== -1) {
      const [parentName, nestedPackageName] = packageName.split("/");
      fs.ensureDirSync(path.join(destinationDir, "node_modules", parentName));
      child_process.execSync(
        `cd ${path.join(
          destinationDir,
          "node_modules",
          parentName
        )} && ln -s ${path.relative(
          path.join(destinationDir, "node_modules", parentName),
          path.join(
            installedNpmPackagesDir,
            "node_modules",
            parentName,
            nestedPackageName
          )
        )} ${nestedPackageName}`,
        {
          stdio: "inherit"
        }
      );
    } else {
      child_process.execSync(
        `cd ${path.join(
          destinationDir,
          "node_modules"
        )} && ln -s ${path.relative(
          path.join(destinationDir, "node_modules"),
          path.join(installedNpmPackagesDir, "node_modules", packageName)
        )} ${packageName}`,
        {
          stdio: "inherit"
        }
      );
    }
  }
}

// Extract compiler options from tsconfig.json, overriding anything other
// than compiler options.
const originalTsConfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf8"));
fs.writeFileSync(
  path.join(destinationDir, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        ...(originalTsConfig.compilerOptions || {}),
        moduleResolution: "node",
        declaration: true,
        rootDir: ".",
        baseUrl: ".",
        paths: {
          "*": [path.join("__internal_node_modules", "*")]
        }
      }
    },
    null,
    2
  ),
  "utf8"
);

// Figure out what "@/..." imports should be relative to. What is "@"?
// TODO: Consider supporting other prefixes specified in tsconfig.paths.
// By default, "@/..." means it's relative to the workspace directory.
let atSignImportDir = ".";
let atSignPatterns;
if (
  originalTsConfig.compilerOptions &&
  originalTsConfig.compilerOptions.paths &&
  (atSignPatterns = originalTsConfig.compilerOptions.paths["@/*"])
) {
  if (atSignPatterns.length !== 1) {
    throw new Error(
      `Multiple paths for "@/*" in tsconfig.json are not supported.`
    );
  }
  const atSignPattern = atSignPatterns[0];
  if (!atSignPattern.endsWith("/*")) {
    throw new Error(
      `Path matcher ${atSignPattern} in tsconfig.json was expected to end with "/*".`
    );
  }
  // Find where the directory pointed to is. This is relative to baseUrl, which
  // is itself related to tsconfig.json's path.
  atSignImportDir = path.join(
    path.dirname(tsconfigPath),
    originalTsConfig.compilerOptions.baseUrl || ".",
    atSignPattern.substr(0, atSignPattern.length - 2)
  );
}

// Copy every internal dependency into the appropriate internal_node_modules/ subdirectory.
fs.mkdirSync(path.join(destinationDir, "__internal_node_modules"));
const pathToPackagedPath = {};
for (const internalDep of internalDeps) {
  if (!internalDep) {
    continue;
  }
  const [
    targetPackage,
    targetName,
    joinedSrcs,
    compiledDir
  ] = internalDep.split(":");
  const srcs = joinedSrcs.split(";");
  const rootModuleName =
    "__" + targetPackage.replace(/\//g, "__") + "__" + targetName;
  for (const src of srcs) {
    if (!src) {
      continue;
    }
    pathToPackagedPath[
      path.join(path.dirname(src), path.parse(src).name)
    ] = path.join(
      rootModuleName,
      path.relative(targetPackage, path.dirname(src)),
      path.parse(src).name
    );
  }
  fs.copySync(
    compiledDir,
    path.join(destinationDir, "__internal_node_modules", rootModuleName),
    {
      dereference: true,
      filter: name => {
        // Do not copy node_modules or internal_node_modules recursively.
        // All dependencies are already added to node_modules within this for loop.
        return name !== "node_modules" && name !== "__internal_node_modules";
      }
    }
  );
}

// Update import statements in this target's sources.
const srcsSet = new Set(srcs);
for (const sourceFilePath of srcs) {
  if (!sourceFilePath) {
    continue;
  }
  if (!fs.existsSync(sourceFilePath)) {
    throw new Error(`Missing file: ${sourceFilePath}.`);
  }
  const destinationFilePath = path.join(
    destinationDir,
    path.relative(buildfileDir, sourceFilePath)
  );
  fs.ensureDirSync(path.dirname(destinationFilePath));
  if (
    !destinationFilePath.endsWith(".ts") &&
    !destinationFilePath.endsWith(".tsx")
  ) {
    // Assets and other non-TypeScript files should simply be copied.
    fs.copySync(sourceFilePath, destinationFilePath);
    continue;
  }
  const sourceText = fs.readFileSync(sourceFilePath, "utf8");
  const sourceFile = ts.createSourceFile(
    path.basename(sourceFilePath),
    sourceText,
    ts.ScriptTarget.Latest,
    true
  );
  for (const statement of sourceFile.statements) {
    // TODO: Also handle require statements.
    if (statement.kind === ts.SyntaxKind.ImportDeclaration) {
      const importFrom = statement.moduleSpecifier.text;
      if (
        importFrom.startsWith("./") ||
        importFrom.startsWith("../") ||
        importFrom.startsWith("@/")
      ) {
        let importPathFromWorkspace;
        if (importFrom[0] === "@") {
          // Workspace-level import, e.g. "@/src/some/path".
          importPathFromWorkspace = path.join(
            atSignImportDir,
            importFrom.substr(2)
          );
        } else {
          importPathFromWorkspace = path.join(
            path.dirname(sourceFilePath),
            importFrom
          );
        }
        let replaceWith;
        for (const potentialImportPath of Object.keys(pathToPackagedPath)) {
          if (importPathFromWorkspace === potentialImportPath) {
            replaceWith = pathToPackagedPath[potentialImportPath];
          }
        }
        if (!replaceWith) {
          // This must be a local import (in the same target).
          // It could either be a TypeScript import, in which case the
          // extension will have been omitted, or it could be an asset such
          // as a CSS stylesheet, in which case the extension does not need
          // to be appended.
          const candidateEndings = [".ts", ".tsx", ""];
          let foundMatch = false;
          for (const candidateEnding of candidateEndings) {
            if (srcsSet.has(importPathFromWorkspace + candidateEnding)) {
              // Good, the file exists.
              foundMatch = true;
              break;
            }
          }
          if (foundMatch) {
            // Make sure to replace any absolute imports such as "@/src/some/path"
            // with relative imports, so we don't need to deal with them at a later
            // stage.
            replaceWith =
              "./" +
              path.relative(
                path.dirname(sourceFilePath),
                importPathFromWorkspace
              );
          } else {
            throw new Error(`Could not find a match for import ${importFrom}.`);
          }
        }
        statement.moduleSpecifier = ts.createLiteral(replaceWith);
      } else {
        // This must be an external package.
        let packageName;
        const splitImportFrom = importFrom.split("/");
        if (splitImportFrom.length >= 2 && splitImportFrom[0].startsWith("@")) {
          // Example: @storybook/react.
          packageName = splitImportFrom[0] + "/" + splitImportFrom[1];
        } else {
          // Example: react.
          packageName = splitImportFrom[0];
        }
        if (!required.has(packageName)) {
          throw new Error(`Undeclared dependency: ${packageName}.`);
        }
      }
    }
  }
  const updatedFile = ts.createPrinter().printFile(sourceFile);
  fs.writeFileSync(destinationFilePath, updatedFile, "utf8");
}
