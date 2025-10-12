/**
 * Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { AllDataMapperSourceRequest, CodeSegment, ComponentInfo, createFunctionSignature, CreateTempFileRequest, DataMapperMetadata, DatamapperModelContext, DataMapperModelResponse, DataMappingRecord, DiagnosticList, Diagnostics, DMModel, EnumType, ExistingFunctionMatchResult, ExtendedDataMapperMetadata, ExtractMappingDetailsRequest, ExtractMappingDetailsResponse, GenerateTypesFromRecordRequest, GenerateTypesFromRecordResponse, getSource, ImportInfo, ImportStatements, IORoot, IOTypeField, LinePosition, Mapping, MetadataWithAttachments, ProjectSource, RecordType, SourceFile, STModification, SyntaxTree, TempDirectoryPath, TextEdit } from "@wso2/ballerina-core";
import { camelCase } from "lodash";
import path from "path";
import * as fs from 'fs';
import * as os from 'os';
import { processMappings, typesFileParameterDefinitions } from "../../rpc-managers/ai-panel/utils";
import { writeBallerinaFileDidOpenTemp } from "../../utils/modification";
import { ExtendedLangClient, NOT_SUPPORTED } from "../../core";
import { TextDocumentEdit } from "vscode-languageserver-types";
import { fileURLToPath } from "url";
import { Uri } from "vscode";
import { getBallerinaProjectRoot } from "../../../src/rpc-managers/ai-panel/rpc-manager";
import { DefaultableParam, FunctionDefinition, IncludedRecordParam, ModulePart, RequiredParam, RestParam, STKindChecker, STNode } from "@wso2/syntax-tree";
import { updateAndRefreshDataMapper } from "../../../src/rpc-managers/data-mapper/utils";
import { attemptRepairProject } from "../../../src/rpc-managers/ai-panel/repair-utils";
import { NullablePrimitiveType, PrimitiveArrayType, PrimitiveType } from "./constants";
import { INVALID_RECORD_REFERENCE } from "../../../src/views/ai-panel/errorCodes";

const isPrimitiveType = (type: string): boolean => {
  return Object.values(PrimitiveType).includes(type as PrimitiveType);
};

const isNullablePrimitiveType = (type: string): boolean => {
  return Object.values(NullablePrimitiveType).includes(type as NullablePrimitiveType);
};

const isPrimitiveArrayType = (type: string): boolean => {
  if (Object.values(PrimitiveArrayType).includes(type as PrimitiveArrayType)) {
    return true;
  }

  // Handle union types like (string|int)[], (string?|int)[]?, etc.
  const unionArrayPattern = /^\(([^)]+)\)\[\](\?)?$/;
  const match = type.match(unionArrayPattern);

  if (match) {
    const unionTypes = match[1].split('|').map(t => t.trim());
    // Check if all types in the union are either primitive types or nullable primitive types
    return unionTypes.every(unionType =>
      isPrimitiveType(unionType) || isNullablePrimitiveType(unionType)
    );
  }
  return false;
};

const isAnyPrimitiveType = (type: string): boolean => {
  return isPrimitiveType(type) || isNullablePrimitiveType(type) || isPrimitiveArrayType(type);
};

// Generate Ballerina types from a record request
export async function generateTypeCreation(
  request: GenerateTypesFromRecordRequest
): Promise<GenerateTypesFromRecordResponse> {
  const file = request.attachment?.[0];

  const updatedSource = await typesFileParameterDefinitions(file);
  if (typeof updatedSource !== 'string') {
    throw new Error(`Failed to generate types: ${JSON.stringify(updatedSource)}`);
  }

  return { typesCode: updatedSource };
}

// Create a temporary Ballerina file with a generated data mapping function
export async function createTempDataMappingFile(params: CreateTempFileRequest): Promise<string> {
  let funcSource: string;

  if (!params.hasMatchingFunction) {
    // Create new function source only if function doesn't exist
    funcSource = createDataMappingFunctionSource(
      params.inputs,
      params.output,
      params.functionName,
      params.inputNames
    );
  }
  const tempFilePath = await createTempBallerinaFile(
    params.tempDir,
    params.filePath,
    funcSource,
    params.imports,
    params.hasMatchingFunction
  );

  return tempFilePath;
}

export async function createCustomFunctionsFile(
  tempDir: string,
  customFunctions: Mapping[]
): Promise<string> {
  let functionsSource = customFunctions
    .map(f => f.functionContent)
    .filter(Boolean)
    .join('\n\n');

  const customFunctionsFilePath = path.join(tempDir, "functions.bal");
  let existingContent = "";
  if (fs.existsSync(customFunctionsFilePath)) {
    existingContent = fs.readFileSync(customFunctionsFilePath, 'utf8');
  }

  functionsSource = existingContent + "\n\n" + functionsSource;

  writeBallerinaFileDidOpenTemp(customFunctionsFilePath, functionsSource);
  return customFunctionsFilePath;
}

export async function getFunctionDefinitionFromSyntaxTree(
  langClient: ExtendedLangClient,
  filePath: string,
  functionName: string
): Promise<FunctionDefinition | null> {
  const st = (await langClient.getSyntaxTree({
    documentIdentifier: {
      uri: Uri.file(filePath).toString(),
    },
  })) as SyntaxTree;

  const modulePart = st.syntaxTree as ModulePart;

  // Find the function definition by name
  for (const member of modulePart.members) {
    if (STKindChecker.isFunctionDefinition(member)) {
      const funcDef = member as FunctionDefinition;
      if (funcDef.functionName?.value === functionName) {
        return funcDef;
      }
    }
  }

  return null;
}

// Create a temporary Ballerina file with optional imports
async function createTempBallerinaFile(
  tempDir: string,
  filePath: string,
  funcSource?: string,
  imports?: ImportInfo[],
  functionExists?: boolean
): Promise<string> {
  let fullSource = funcSource;

  if (imports && imports.length > 0) {
    const importsString = imports
      .map(({ moduleName, alias }) =>
        alias ? `import ${moduleName} as ${alias};` : `import ${moduleName};`
      )
      .join("\n");
    fullSource = `${importsString}\n\n${funcSource}`;
  }

  const tempTestFilePath = path.join(tempDir, filePath);

  let existingContent = "";
  if (fs.existsSync(tempTestFilePath)) {
    existingContent = fs.readFileSync(tempTestFilePath, 'utf8');
  }

  if (!functionExists) {
    fullSource = existingContent + "\n\n" + fullSource;
  } else {
    fullSource = existingContent;
  }
  writeBallerinaFileDidOpenTemp(tempTestFilePath, fullSource);
  return tempTestFilePath;
}

export async function createTempBallerinaDir(): Promise<string> {
  const projectRoot = await getBallerinaProjectRoot();
  const randomNum = Math.floor(Math.random() * 90000) + 10000;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `ballerina-data-mapping-${randomNum}-`)
  );
  fs.cpSync(projectRoot, tempDir, { recursive: true });
  return tempDir;
}

export async function repairCodeWithLLM(sourceFiles: SourceFile[]): Promise<ProjectSource> {
  // Process each source file
  for (const sourceFile of sourceFiles) {
    try {
      writeBallerinaFileDidOpenTemp(
        sourceFile.filePath,
        sourceFile.content
      );
    } catch (error) {
      console.error(`Error processing file ${sourceFile.filePath}:`, error);
    }
  }

  const response = { sourceFiles: sourceFiles, projectName: "" };
  return response;
}

// Generate the Ballerina source for a data mapping function
export function createDataMappingFunctionSource(
  inputParams: DataMappingRecord[],
  outputParam: DataMappingRecord,
  functionName: string,
  inputNames: string[]
): string {
  const parametersStr = buildParametersString(inputParams, inputNames);
  const returnTypeStr = buildReturnTypeString(outputParam);

  const modification = createFunctionSignature(
    "",
    functionName,
    parametersStr,
    returnTypeStr,
    { startLine: 0, startColumn: 0 },
    false,
    true,
    "{}"
  );

  return getSource(modification);
}

// Generate parameters string for function signature
function buildParametersString(
  inputParams: DataMappingRecord[],
  inputNames: string[]
): string {
  return inputParams
    .map((item, index) => {
      const paramName =
        inputNames[index] || getDefaultParamName(item.type, item.isArray);
      return formatParameter(item, paramName);
    })
    .join(", ");
}

// Generate a default parameter name for primitives and custom types
function getDefaultParamName(type: string, isArray: boolean): string {
  const processedType = processType(type);

  switch (processedType) {
    case PrimitiveType.STRING:
      return isArray ? "strArr" : "str";
    case PrimitiveType.INT:
      return isArray ? "numArr" : "num";
    case PrimitiveType.FLOAT:
      return isArray ? "fltArr" : "flt";
    case PrimitiveType.DECIMAL:
      return isArray ? "decArr" : "dec";
    case PrimitiveType.BOOLEAN:
      return isArray ? "flagArr" : "flag";
    default:
      return camelCase(processedType);
  }
}

// Extract the actual type name from a fully qualified type
function processType(type: string): string {
  let typeName = type.includes("/") ? type.split("/").pop()! : type;

  if (typeName.includes(":")) {
    const [modulePart, typePart] = typeName.split(":");
    typeName = `${modulePart.split(".").pop()}:${typePart}`;
  }

  return typeName;
}

// Format a single function parameter
function formatParameter(
  item: DataMappingRecord,
  paramName: string
): string {
  return `${processType(item.type)}${item.isArray ? "[]" : ""} ${paramName}`;
}

// Generate return type string
function buildReturnTypeString(outputParam: DataMappingRecord): string {
  return `returns ${processType(outputParam.type)}${outputParam.isArray ? "[]" : ""
    }`;
}

export async function repairMappingDiagnostics(
  diagnosticsResult: Diagnostics[],
  langClient: ExtendedLangClient
): Promise<boolean> {
  let projectModified = false;

  for (const diag of diagnosticsResult) {
    const fileUri = diag.uri;
    const diagnostics = diag.diagnostics;

    if (!diagnostics.length) {
      continue;
    }

    // Filter to get unique diagnostics based on their message
    const uniqueDiagnosticMap = new Map();
    for (const d of diagnostics) {
      if (!uniqueDiagnosticMap.has(d.message)) {
        uniqueDiagnosticMap.set(d.message, d);
      }
    }
    const uniqueDiagnostics = Array.from(uniqueDiagnosticMap.values());

    const astModifications: STModification[] = [];

    for (const d of uniqueDiagnostics) {
      try {
        // Get code actions for each diagnostic
        const codeActions = await langClient.codeAction({
          textDocument: { uri: fileUri },
          range: {
            start: d.range.start,
            end: d.range.end
          },
          context: { diagnostics: [d], only: ["quickfix"] }
        });

        if (!codeActions?.length) {
          continue;
        }

        // Pick the first action (or refine based on title/type)
        const action = codeActions[0];
        if (!action?.edit?.documentChanges?.length) {
          continue;
        }

        // Extract edit from document changes
        const docEdit = action.edit.documentChanges[0] as TextDocumentEdit;
        const edit = docEdit.edits[0];

        astModifications.push({
          startLine: edit.range.start.line,
          startColumn: edit.range.start.character,
          endLine: edit.range.end.line,
          endColumn: edit.range.end.character,
          type: "INSERT",
          isImport: action.title?.startsWith("Import") ?? false,
          config: { STATEMENT: edit.newText }
        });
      } catch (err) {
        console.warn(`Could not apply code action for ${fileUri}:`, err);
      }
    }

    if (astModifications.length > 0) {
      const syntaxTree = await langClient.stModify({
        documentIdentifier: { uri: fileUri },
        astModifications: astModifications
      });

      // Update file content
      const { source } = syntaxTree as SyntaxTree;
      const absolutePath = fileURLToPath(fileUri);
      writeBallerinaFileDidOpenTemp(absolutePath, source);
      projectModified = true;
    }
  }
  return projectModified;
}

export function createTextEditsFromSegment(
  params: CodeSegment,
  context: any
): { [key: string]: TextEdit[] } {
  if (params.textEdit?.textEdits) {
    return params.textEdit.textEdits;
  }

  const filePath = params.filePath?.trim() || context.documentUri;
  const metadata = params.metadata || context.dataMapperMetadata;

  const textEdit: TextEdit = {
    newText: params.segmentText,
    range: {
      start: {
        line: metadata.codeData.lineRange.startLine.line,
        character: metadata.codeData.lineRange.startLine.offset
      },
      end: {
        line: metadata.codeData.lineRange.endLine.line,
        character: metadata.codeData.lineRange.endLine.offset
      }
    }
  };

  return {
    [filePath]: [textEdit]
  };
}

export async function generateDataMapperModel(
  params: DatamapperModelContext,
  langClient: ExtendedLangClient,
  context: any
): Promise<DataMapperModelResponse> {
  let filePath: string;
  let identifier: string;
  let dataMapperMetadata: DataMapperMetadata;

  if (params && params.documentUri && params.identifier) {
    filePath = params.documentUri;
    identifier = params.identifier;
    dataMapperMetadata = params.dataMapperMetadata;
  } else {
    filePath = context.documentUri;
    identifier = context.identifier || context.dataMapperMetadata.name;
    dataMapperMetadata = context.dataMapperMetadata;
  }

  let position: LinePosition = {
    line: dataMapperMetadata.codeData.lineRange.startLine.line,
    offset: dataMapperMetadata.codeData.lineRange.startLine.offset
  };

  if (!dataMapperMetadata.codeData.hasOwnProperty('node') ||
    dataMapperMetadata.codeData.node !== "VARIABLE") {
    const fileUri = Uri.file(filePath).toString();
    const fnSTByRange = await langClient.getSTByRange({
      lineRange: {
        start: {
          line: dataMapperMetadata.codeData.lineRange.startLine.line,
          character: dataMapperMetadata.codeData.lineRange.startLine.offset
        },
        end: {
          line: dataMapperMetadata.codeData.lineRange.endLine.line,
          character: dataMapperMetadata.codeData.lineRange.endLine.offset
        }
      },
      documentIdentifier: { uri: fileUri }
    });

    if (fnSTByRange === NOT_SUPPORTED) {
      throw new Error("Syntax tree retrieval not supported");
    }

    const fnSt = (fnSTByRange as SyntaxTree).syntaxTree as STNode;

    if (STKindChecker.isFunctionDefinition(fnSt) &&
      STKindChecker.isExpressionFunctionBody(fnSt.functionBody)) {
      position = {
        line: fnSt.functionBody.expression.position.startLine,
        offset: fnSt.functionBody.expression.position.startColumn
      };
    }
  }

  let dataMapperModel = await langClient
    .getDataMapperMappings({
      filePath,
      codedata: dataMapperMetadata.codeData,
      targetField: identifier,
      position: position
    }) as DataMapperModelResponse;

  let mappingsModel = ensureUnionRefs(dataMapperModel.mappingsModel as DMModel);
  mappingsModel = normalizeRefs(mappingsModel);

  // Process submappings if they exist
  if (mappingsModel.subMappings && mappingsModel.subMappings.length > 0) {
    mappingsModel.subMappings = await processSubMappings(
      mappingsModel.subMappings,
      filePath,
      dataMapperMetadata.codeData,
      langClient,
      position
    );
  }

  return { mappingsModel };
}

export async function createTempFileAndGenerateMetadata(params: CreateTempFileRequest, langClient: ExtendedLangClient, context: any): Promise<ExtendedDataMapperMetadata> {
  let filePath = await createTempDataMappingFile(params);

  if (!params.metadata || Object.keys(params.metadata).length === 0) {
    // Get the complete syntax tree
    const funcDefinitionNode = await getFunctionDefinitionFromSyntaxTree(
      langClient,
      filePath,
      params.functionName
    );

    // Create dataMapperMetadata with the found positions
    const dataMapperMetadata = {
      name: params.functionName,
      codeData: {
        lineRange: {
          fileName: filePath,
          startLine: {
            line: funcDefinitionNode.position.startLine,
            offset: funcDefinitionNode.position.startColumn,
          },
          endLine: {
            line: funcDefinitionNode.position.endLine,
            offset: funcDefinitionNode.position.endColumn,
          },
        },
      }
    };

    const dataMapperModel = await generateDataMapperModel(
      {
        documentUri: filePath,
        identifier: params.functionName,
        dataMapperMetadata: dataMapperMetadata
      },
      langClient,
      context
    );

    return {
      mappingsModel: dataMapperModel.mappingsModel as DMModel,
      name: params.functionName,
      codeData: dataMapperMetadata.codeData
    };
  }

  // Update the file path to the temp file path
  const updatedMetadata = {
    ...params.metadata,
    codeData: {
      ...params.metadata.codeData,
      lineRange: {
        ...params.metadata.codeData.lineRange,
        fileName: filePath
      }
    }
  };

  return {
    mappingsModel: updatedMetadata.mappingsModel,
    name: params.functionName,
    codeData: updatedMetadata.codeData
  };
}

function ensureUnionRefs(model: DMModel): DMModel {
  const processedModel = JSON.parse(JSON.stringify(model));
  const unionRefs = new Map<string, any>();

  // Visitor interface
  interface FieldVisitor {
    visitUnion(field: any): void;
    visitRecord(field: any): void;
    visitArray(field: any): void;
    visitField(field: any): void;
  }

  // Concrete visitor for collecting union refs
  class UnionRefCollector implements FieldVisitor {
    visitUnion(field: any): void {
      if (field.ref) {
        const refId = field.ref;

        if (!processedModel.refs[refId] && !unionRefs.has(refId)) {
          unionRefs.set(refId, {
            members: field.members || [],
            typeName: field.typeName,
            kind: 'union'
          });
        }

        field.members = [];
      }
    }

    visitRecord(field: any): void {
      if (field.fields) {
        this.visitFields(field.fields);
      }
    }

    visitArray(field: any): void {
      if (field.member) {
        this.visitField(field.member);
      }
    }

    visitField(field: any): void {
      if (!field) { return; }

      // Visit based on kind
      switch (field.kind) {
        case 'union':
          this.visitUnion(field);
          break;
        case 'record':
          this.visitRecord(field);
          break;
        case 'array':
          this.visitArray(field);
          break;
      }

      // Process members array if it exists
      if (field.members && Array.isArray(field.members)) {
        field.members.forEach(member => this.visitField(member));
      }

      // Process single member if it exists (for non-array types)
      if (field.member && field.kind !== 'array') {
        this.visitField(field.member);
      }
    }

    visitFields(fields: any[]): void {
      if (!fields || !Array.isArray(fields)) { return; }

      for (const field of fields) {
        this.visitField(field);
      }
    }
  }

  // Concrete visitor for clearing union members
  class UnionMemberClearer implements FieldVisitor {
    visitUnion(field: any): void {
      if (field.ref && field.members) {
        field.members = [];
      }
    }

    visitRecord(field: any): void {
      if (field.fields) {
        this.visitFields(field.fields);
      }
    }

    visitArray(field: any): void {
      if (field.member) {
        this.visitField(field.member);
      }
    }

    visitField(field: any): void {
      if (!field || typeof field !== 'object') { return; }

      if (Array.isArray(field)) {
        field.forEach(item => this.visitField(item));
        return;
      }

      // Visit based on kind
      switch (field.kind) {
        case 'union':
          this.visitUnion(field);
          break;
        case 'record':
          this.visitRecord(field);
          break;
        case 'array':
          this.visitArray(field);
          break;
      }

      // Recursively visit all nested objects
      for (const key of Object.keys(field)) {
        if (typeof field[key] === 'object') {
          this.visitField(field[key]);
        }
      }
    }

    visitFields(fields: any[]): void {
      if (!fields || !Array.isArray(fields)) { return; }

      for (const field of fields) {
        this.visitField(field);
      }
    }
  }

  const collector = new UnionRefCollector();

  // Process inputs
  if (processedModel.inputs) {
    collector.visitFields(processedModel.inputs);
  }

  // Process output
  if (processedModel.output) {
    if (processedModel.output.fields) {
      collector.visitFields(processedModel.output.fields);
    } else {
      collector.visitField(processedModel.output);
    }
  }

  // Process subMappings
  if (processedModel.subMappings) {
    collector.visitFields(processedModel.subMappings);
  }

  // Process existing refs
  if (processedModel.refs) {
    for (const refKey of Object.keys(processedModel.refs)) {
      const refObj = processedModel.refs[refKey];
      if (refObj.fields) {
        collector.visitFields(refObj.fields);
      } else if (refObj.members) {
        refObj.members.forEach(member => collector.visitField(member));
      }
    }
  }

  // Add the collected union refs to the model
  unionRefs.forEach((unionRef, refId) => {
    if (!processedModel.refs[refId]) {
      processedModel.refs[refId] = unionRef;
    }
  });

  // Clear union members using the clearer visitor
  const clearer = new UnionMemberClearer();

  clearer.visitField(processedModel.inputs);
  clearer.visitField(processedModel.output);
  if (processedModel.subMappings) {
    clearer.visitField(processedModel.subMappings);
  }

  // Clear members from union fields in existing refs (but preserve union ref definitions)
  if (processedModel.refs) {
    for (const refKey of Object.keys(processedModel.refs)) {
      const refObj = processedModel.refs[refKey];
      if (refObj.kind === 'record' && refObj.fields) {
        clearer.visitField(refObj.fields);
      }
    }
  }

  return processedModel;
}

export function normalizeRefs(model: DMModel): DMModel {
  // Deep clone to avoid mutating the original
  const processedModel: DMModel = JSON.parse(JSON.stringify(model));

  // Recursive function to remove 'ref' from any field
  function removeRef(field: IOTypeField) {
    if (!field || typeof field !== 'object') { return; }

    delete field.ref;

    if (field.member) { removeRef(field.member); }
    if (Array.isArray(field.members)) { field.members.forEach(removeRef); }
    if ((field as any).fields && Array.isArray((field as any).fields)) {
      (field as any).fields.forEach(removeRef);
    }
  }

  // Remove refs in inputs
  if (processedModel.inputs) { processedModel.inputs.forEach(removeRef); }

  // Remove refs in output
  if (processedModel.output) { removeRef(processedModel.output); }

  // Remove refs in subMappings
  if (processedModel.subMappings) {
    processedModel.subMappings.forEach((sub) => removeRef(sub as IOTypeField));
  }

  // Rebuild refs object with typeName as keys
  const newRefs: Record<string, RecordType | EnumType> = {};
  if (processedModel.refs) {
    for (const refObj of Object.values(processedModel.refs)) {
      const typeName = (refObj as RecordType).typeName;
      if (typeName) {
        // Remove any nested 'ref' inside this refObj
        if ((refObj as RecordType).fields) {
          (refObj as RecordType).fields.forEach(removeRef);
        }
        newRefs[typeName] = refObj as RecordType | EnumType;
      }
    }
  }

  processedModel.refs = newRefs;

  return processedModel;
}

async function processSubMappings(
  subMappings: any[],
  filePath: string,
  codeData: any,
  langClient: ExtendedLangClient,
  position?: LinePosition
): Promise<Mapping[]> {
  const allSubMappings: Mapping[] = [];

  for (const subMapping of subMappings) {
    const subMappingCodeData = await langClient.getSubMappingCodedata({
      filePath,
      codedata: codeData,
      view: (subMapping as IORoot).name
    });

    const subMappingModel = await langClient.getDataMapperMappings({
      filePath,
      codedata: subMappingCodeData.codedata,
      targetField: (subMapping as IORoot).name,
      position: position
    }) as DataMapperModelResponse;

    // Extract mappings from subMappingModel
    if (subMappingModel.mappingsModel &&
      'mappings' in subMappingModel.mappingsModel &&
      subMappingModel.mappingsModel.mappings) {
      allSubMappings.push(...subMappingModel.mappingsModel.mappings);
    }
  }

  return allSubMappings;
}

export async function extractMappingDetails(
  params: ExtractMappingDetailsRequest,
  langClient: ExtendedLangClient
): Promise<ExtractMappingDetailsResponse> {
  const { parameters, recordMap, projectImports, existingFunctions } = params;
  const importsMap: Record<string, ImportInfo> = {};
  let inputParams: string[];
  let outputParam: string;
  let inputNames: string[] = [];

  const existingFunctionMatch = await processExistingFunctions(
    existingFunctions,
    parameters.functionName,
    langClient
  );

  const hasProvidedRecords = parameters.inputRecord.length > 0 || parameters.outputRecord !== "";

  if (hasProvidedRecords) {
    if (existingFunctionMatch.match) {
      throw new Error(
        `"${parameters.functionName}" function already exists. Please provide a valid function name.`
      );
    }
    inputParams = parameters.inputRecord;
    outputParam = parameters.outputRecord;
  } else {
    if (!existingFunctionMatch.match || !existingFunctionMatch.functionDefNode) {
      throw new Error(
        `"${parameters.functionName}" function was not found. Please provide a valid function name.`
      );
    }

    const funcNode = existingFunctionMatch.functionDefNode;
    const params = funcNode.functionSignature.parameters?.filter(
      (param): param is RequiredParam | DefaultableParam | RestParam | IncludedRecordParam =>
        param.kind !== 'CommaToken'
    ) ?? [];

    inputParams = params.map(param => (param.typeName.source || "").trim());
    inputNames = params.map(param => (param.paramName.value || "").trim());
    outputParam = (funcNode.functionSignature.returnTypeDesc.type.source || "").trim();
  }

  const allImports = projectImports.flatMap(file => file.statements || []);
  const inputs = processInputs(inputParams, recordMap, allImports, importsMap);
  const output = processOutput(outputParam, recordMap, allImports, importsMap);

  return {
    inputs,
    output,
    inputParams,
    outputParam,
    imports: Object.values(importsMap),
    inputNames,
    existingFunctionMatch,
  };
}

// Processes existing functions to find a matching function by name
export async function processExistingFunctions(
  existingFunctions: ComponentInfo[],
  functionName: string,
  langClient: ExtendedLangClient
): Promise<ExistingFunctionMatchResult> {
  for (const func of existingFunctions) {
    const filePath = func.filePath;
    const fileName = filePath.split("/").pop();

    const funcDefNode = await getFunctionDefinitionFromSyntaxTree(langClient, filePath, functionName);
    if (funcDefNode) {
      return {
        match: true,
        matchingFunctionFile: fileName,
        functionDefNode: funcDefNode,
      };
    } else {
      continue;
    }
  }

  // If no match found
  return {
    match: false,
    matchingFunctionFile: null,
    functionDefNode: null,
  };
}

// Process input parameters
export function processInputs(
  inputParams: string[],
  recordMap: Record<string, any>,
  allImports: ImportInfo[],
  importsMap: Record<string, any>
) {
  let results = inputParams.map((param: string) =>
    processRecordReference(param, recordMap, allImports, importsMap)
  );
  return results.filter((result): result is DataMappingRecord => {
    if (result instanceof Error) {
      throw INVALID_RECORD_REFERENCE;
    }
    return true;
  });
}

// Process Output parameters
export function processOutput(
  outputParam: string,
  recordMap: Record<string, any>,
  allImports: ImportInfo[],
  importsMap: Record<string, any>
) {
  const outputResult = processRecordReference(outputParam, recordMap, allImports, importsMap);
  if (outputResult instanceof Error) {
    throw INVALID_RECORD_REFERENCE;
  }
  return outputResult;
}

// Validate and register an imported type in the imports map
function registerImportedType(
  typeName: string,
  allImports: ImportInfo[],
  importsMap: Record<string, { moduleName: string; alias?: string; recordName: string }>
): void {
  if (!typeName.includes("/")) {
    const [moduleName, recName] = typeName.split(":");
    const matchedImport = allImports.find((imp) => {
      if (imp.alias) {
        return typeName.startsWith(imp.alias);
      }
      const moduleNameParts = imp.moduleName.split(/[./]/);
      const inferredAlias = moduleNameParts[moduleNameParts.length - 1];
      return typeName.startsWith(inferredAlias);
    });

    if (!matchedImport) {
      throw new Error(`Import not found for: ${typeName}`);
    }
    importsMap[typeName] = {
      moduleName: matchedImport.moduleName,
      alias: matchedImport.alias,
      recordName: recName,
    };
  } else {
    const [moduleName, recName] = typeName.split(":");
    importsMap[typeName] = {
      moduleName: moduleName,
      recordName: recName,
    };
  }
}

// Validate that a type exists as either a primitive, local record, or imported type
function validateTypeExists(
  typeName: string,
  recordMap: Record<string, any>,
  allImports: ImportInfo[],
  importsMap: Record<string, { moduleName: string; alias?: string; recordName: string }>
): void {
  if (isAnyPrimitiveType(typeName)) {
    return;
  }

  const cleanedType = typeName.replace(/\[\]$/, "");

  if (recordMap[cleanedType]) {
    return;
  }

  if (cleanedType.includes(":")) {
    registerImportedType(cleanedType, allImports, importsMap);
    return;
  }

  throw new Error(`${cleanedType} is not defined.`);
}

// Process and validate a union type, returning its data mapping record
function processUnionType(
  unionTypeString: string,
  recordMap: Record<string, any>,
  allImports: ImportInfo[],
  importsMap: Record<string, { moduleName: string; alias?: string; recordName: string }>
): DataMappingRecord {
  const unionTypes = unionTypeString.split("|").map(t => t.trim());

  for (const unionType of unionTypes) {
    validateTypeExists(unionType, recordMap, allImports, importsMap);
  }

  return { type: unionTypeString, isArray: false, filePath: null };
}

// Process and validate a single type reference, returning its data mapping record
function processSingleType(
  typeName: string,
  recordMap: Record<string, any>,
  allImports: ImportInfo[],
  importsMap: Record<string, { moduleName: string; alias?: string; recordName: string }>
): DataMappingRecord {
  if (isAnyPrimitiveType(typeName)) {
    return { type: typeName, isArray: false, filePath: null };
  }

  const isArray = typeName.endsWith("[]") && !isPrimitiveArrayType(typeName);
  const cleanedRecordName = isArray ? typeName.replace(/\[\]$/, "") : typeName;

  const rec = recordMap[cleanedRecordName];

  if (rec) {
    return { ...rec, isArray };
  }

  if (cleanedRecordName.includes(":")) {
    registerImportedType(cleanedRecordName, allImports, importsMap);
    return { type: typeName, isArray, filePath: null };
  }

  throw new Error(`${cleanedRecordName} is not defined.`);
}

// Process a record type reference and validate it exists, handling both union and single types
export function processRecordReference(
  recordName: string,
  recordMap: Record<string, any>,
  allImports: ImportInfo[],
  importsMap: Record<string, { moduleName: string; alias?: string; recordName: string }>
): DataMappingRecord {
  const trimmedRecordName = recordName.trim();

  if (trimmedRecordName.includes("|")) {
    return processUnionType(trimmedRecordName, recordMap, allImports, importsMap);
  }

  return processSingleType(trimmedRecordName, recordMap, allImports, importsMap);
}

export async function repairAndCheckDiagnostics(
  langClient: ExtendedLangClient,
  projectRoot: string,
  params: TempDirectoryPath
): Promise<DiagnosticList> {
  const targetDir = params.tempDir && params.tempDir.trim() !== "" ? params.tempDir : projectRoot;

  let fixed: boolean;
  let diagnostics = await attemptRepairProject(langClient, targetDir);

  // Step 1: Filter diagnostics to only include files in the provided filePaths array
  const filteredDiagnostics = diagnostics.filter(diag =>
    params.filePaths.some(filePath => diag.uri.includes(filePath))
  );

  if (filteredDiagnostics.length > 0) {
    // Step 2: Attempt repairs
    fixed = await repairMappingDiagnostics(filteredDiagnostics, langClient);
  }

  // Step 3: Re-check diagnostics if fixes were attempted
  if (fixed) {
    diagnostics = await attemptRepairProject(langClient, targetDir);
    // Step 4: Filter again after re-check
    return {
      diagnosticsList: diagnostics.filter(diag =>
        params.filePaths.some(filePath => diag.uri.includes(filePath))
      )
    };
  }
  return { diagnosticsList: filteredDiagnostics };
}

export async function addInlineCodeSegmentToWorkspace(
  params: CodeSegment,
  context: any
): Promise<void> {
  let filePath = context.documentUri;
  const datamapperMetadata = context.dataMapperMetadata;
  const textEdit: TextEdit = {
    newText: params.segmentText,
    range: {
      start: {
        line: datamapperMetadata.codeData.lineRange.startLine.line,
        character: datamapperMetadata.codeData.lineRange.startLine.offset
      },
      end: {
        line: datamapperMetadata.codeData.lineRange.endLine.line,
        character: datamapperMetadata.codeData.lineRange.endLine.offset
      }
    }
  };
  const allTextEdits: { [key: string]: TextEdit[] } = {
    [filePath]: [textEdit]
  };

  await updateAndRefreshDataMapper(
    allTextEdits,
    filePath,
    datamapperMetadata.codeData,
    datamapperMetadata.name,
    datamapperMetadata.name
  );
}

export async function generateMappings(
  params: MetadataWithAttachments,
  context: any
): Promise<AllDataMapperSourceRequest> {
  const filePath = params.metadata.codeData.lineRange.fileName || context.documentUri;

  const file = params.attachments && params.attachments.length > 0
    ? params.attachments[0]
    : undefined;

  const mappingElement = await processMappings(params.metadata.mappingsModel as DMModel, file);

  // Extract custom functions
  const customFunctions = mappingElement.filter(m => m.isFunctionCall);
  let customFunctionsFilePath: string | undefined;

  if (customFunctions.length > 0) {
    let tempDir = path.dirname(params.metadata.codeData.lineRange.fileName);
    customFunctionsFilePath = await createCustomFunctionsFile(
      tempDir,
      customFunctions
    );
  }

  const allMappingsRequest: AllDataMapperSourceRequest = {
    filePath,
    codedata: params.metadata.codeData,
    varName: params.metadata.name,
    position: {
      line: params.metadata.codeData.lineRange.startLine.line,
      offset: params.metadata.codeData.lineRange.startLine.offset
    },
    mappings: mappingElement,
    customFunctionsFilePath
  };

  return allMappingsRequest;
}

export function processImportsFromFiles(ballerinaFiles: string[]): ImportStatements[] {
  const imports: ImportStatements[] = [];

  for (const file of ballerinaFiles) {
    const fileContent = fs.readFileSync(file, "utf8");
    const fileImports = extractImports(fileContent, file);
    imports.push(fileImports);
  }

  return imports;
}

function extractImports(content: string, filePath: string): ImportStatements {
  const withoutSingleLineComments = content.replace(/\/\/.*$/gm, "");
  const withoutComments = withoutSingleLineComments.replace(/\/\*[\s\S]*?\*\//g, "");

  const importRegex = /import\s+([\w\.\/]+)(?:\s+as\s+([\w]+))?;/g;
  const imports: ImportInfo[] = [];
  let match;

  while ((match = importRegex.exec(withoutComments)) !== null) {
    const importStatement: ImportInfo = { moduleName: match[1] };
    if (match[2]) {
      importStatement.alias = match[2];
    }
    imports.push(importStatement);
  }

  return { filePath, statements: imports };
}
