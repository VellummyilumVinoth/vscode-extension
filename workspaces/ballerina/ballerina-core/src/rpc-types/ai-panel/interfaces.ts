/* eslint-disable @typescript-eslint/no-explicit-any */
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

import { NodePosition } from "@wso2/syntax-tree";
import { AIMachineContext, AIMachineStateValue } from "../../state-machine-types";
import { Command, TemplateId } from "../../interfaces/ai-panel";
import { FormField } from "../../interfaces/config-spec";

// ==================================
// General Interfaces
// ==================================
export type AIPanelPrompt =
    | { type: 'command-template'; command: Command; templateId: TemplateId; text?: string; params?: Map<string, string>; metadata?: Record<string, any> }
    | { type: 'text'; text: string }
    | undefined;

export interface AIMachineSnapshot {
    state: AIMachineStateValue;
    context: AIMachineContext;
}

export type ErrorCode = {
    code: number;
    message: string;
}

export interface FetchDataRequest {
    url: string;
    options: RequestInit;
}

export interface FetchDataResponse {
    response: Response
}

export interface ProjectSource {
    projectModules?: ProjectModule[];
    projectTests?: SourceFile[];
    sourceFiles: SourceFile[];
    projectName: string;
}

export interface ProjectModule {
    moduleName: string;
    sourceFiles: SourceFile[];
    isGenerated: boolean;
}

export interface SourceFile {
    filePath: string;
    content: string;
}

export interface GetModuleDirParams {
    filePath: string;
    moduleName: string;
}

export interface ProjectDiagnostics {
    diagnostics: DiagnosticEntry[];
}

export interface DiagnosticEntry {
    line?: number;
    message: string;
    code?: string;
}

export interface AddToProjectRequest {
    filePath: string;
    content: string;
    isTestCode: boolean;
}
export interface GetFromFileRequest {
    filePath: string;
}
export interface DeleteFromProjectRequest {
    filePath: string;
}

// Data-mapper related interfaces
export interface GenerateMappingsRequest {
    position: NodePosition;
    filePath: string;
    file?: Attachment;
}

export interface GenerateMappingsResponse {
    newFnPosition?: NodePosition;
    error?: ErrorCode;
    userAborted?: boolean;
}

export interface NotifyAIMappingsRequest {
    newFnPosition: NodePosition;
    prevFnSource: string;
    filePath: string;
}

export interface RecordDefinitonObject {
  recordFields: NestedFieldDescriptor;
  recordFieldsMetadata: {
    [fieldName: string]: FieldMetadata;
  };
}

export interface SimpleFieldDescriptor {
    type: string;
    comment: string;
}

export type NestedFieldDescriptor = {
  [key: string]: SimpleFieldDescriptor | NestedFieldDescriptor;
};

export interface FieldMetadata {
    typeName: string;
    type: string;
    typeInstance: string;
    optional: boolean;
    nullable?: boolean;
    nullableArray?: boolean;
    members?: {
        [memberName: string]: FieldMetadata;
    };

    fields?: {
        [fieldName: string]: FieldMetadata;
    };
}

export interface ParameterField {
    isArrayType: boolean;
    parameterName: string;
    parameterType: string;
    type: string;
    members?: {
        [memberName: string]: FieldMetadata;
    };
    fields?: {
        [fieldName: string]: FieldMetadata;
    };
}

export interface InputMetadata {
  [parameterName: string]: ParameterField;
}

export interface OutputMetadata {
  [fieldName: string]: FieldMetadata;
}

export interface MappingField {
  MAPPING_TIP: string;
  INPUT_FIELDS: string[];
}

export interface MappingFields {
  [outputField: string]: MappingField;
}

export interface ParameterMetadata {
    inputs: NestedFieldDescriptor;
    output: NestedFieldDescriptor;
    inputMetadata: InputMetadata;
    outputMetadata: OutputMetadata;
    mapping_fields?: MappingFields;
    constants?: Record<string, FieldMetadata>;
    configurables?: Record<string, FieldMetadata>;
    variables?: Record<string, FieldMetadata>;
}

export interface MappingFileRecord {
    mapping_fields: MappingFields;
}

export interface ParameterDefinitions {
    parameterMetadata: ParameterMetadata,
    errorStatus: boolean
}

export interface CodeSegment {
    segmentText: string;
    filePath: string;
}

export interface MappingData {
    operation: string;
    parameters: string[];
    targetType: string;
}

export interface IntermediateMapping {
    [key: string]: MappingData | IntermediateMapping;
}

export interface MappingsResponse {
    mappings: IntermediateMapping;
}

export interface ProcessParentKeyResult {
    itemKey: string;
    combinedKey: string;
    inputArrayNullable: boolean;
}

export interface ProcessCombinedKeyResult {
    isinputRecordArrayNullable: boolean;
    isinputRecordArrayOptional: boolean;
    isinputArrayNullable: boolean;
    isinputArrayOptional: boolean;
    isinputNullableArray: boolean;
}

export interface VisitorContext {
    recordFields: NestedFieldDescriptor;
    recordFieldsMetadata: { [key: string]: FieldMetadata };
    memberRecordFields: NestedFieldDescriptor;
    memberFieldsMetadata: { [key: string]: FieldMetadata };
    fieldMetadata: FieldMetadata;
    isNill: boolean;
    isNullable: boolean;
    isArray: boolean;
    isRecord: boolean;
    isSimple: boolean;
    isUnion: boolean;
    isArrayNullable: boolean;
    isRecordNullable: boolean;
    memberName: string;
}

// Test-generator related interfaces
export enum TestGenerationTarget {
    Service = "service",
    Function = "function"
}

export interface TestGenerationRequest {
    backendUri: string;
    targetType: TestGenerationTarget;
    targetIdentifier: string;
    testPlan?: string;
    diagnostics?: ProjectDiagnostics;
    existingTests?: string;
}

export interface TestGenerationResponse {
    testSource: string;
    testConfig?: string;
}

export interface TestGenerationMentions {
    mentions: string[];
}

export interface DataMappingRecord {
    type: string;
    isArray: boolean;
    filePath: string;
}

export interface GenerateMappingsFromRecordRequest {
    backendUri: string;
    token: string;
    inputRecordTypes: DataMappingRecord[];
    outputRecordType: DataMappingRecord;
    functionName: string;
    imports: { moduleName: string; alias?: string }[];
    inputNames?: string[];
    attachment?: Attachment[]
}

export interface GenerateTypesFromRecordRequest {
    backendUri: string;
    token: string;
    attachment?: Attachment[]
}

export interface GenerateMappingFromRecordResponse {
    mappingCode: string;
}
export interface GenerateTypesFromRecordResponse {
    typesCode: string;
}
export interface MappingParameters {
    inputRecord: string[];
    outputRecord: string,
    functionName?: string;
}


export interface PostProcessRequest {
    assistant_response: string;
}

export interface PostProcessResponse {
    assistant_response: string;
    diagnostics: ProjectDiagnostics;
}

export interface AIChatSummary {
    filepath: string;
    summary: string;
}

export interface DeveloperDocument {
    filepath: string;
    content: string;
}

export interface RequirementSpecification {
    filepath: string;
    content: string;
}

export interface DocAssistantResponse {
    content: string;
    references: string[];
}

export interface LLMDiagnostics {
    statusCode: number;
    diags: string;
}

export interface ExistingFunction {
    name: string;
    filePath: string;
    startLine: number;
    endLine: number;
}

// ==================================
// Attachment-Related Interfaces
// ==================================
export interface Attachment {
    name: string;
    path?: string
    content?: string;
    status: AttachmentStatus;
}

export enum AttachmentStatus {
    Success = "Success",
    FileSizeExceeded = "FileSizeExceeded",
    UnsupportedFileFormat = "UnsupportedFileFormat",
    UnknownError = "UnknownError",
}

// ==================================
// Feedback form related Interfaces
// ==================================
export interface SubmitFeedbackRequest {
    positive: boolean;
    messages: FeedbackMessage[];
    feedbackText : string;
    diagnostics: DiagnosticEntry[];
}

export interface FeedbackMessage {
    command?: string;
    content: string;
    role : string;
}
