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

import { Attachment, AttachmentStatus, DiagnosticEntry, DataMapperModelResponse, Mapping, FileChanges, DMModel, SourceFile, repairCodeRequest} from "@wso2/ballerina-core";
import { Position, Range, Uri, workspace, WorkspaceEdit } from 'vscode';

import path from "path";
import * as fs from 'fs';
import { AIChatError } from "./utils/errors";
import { DatamapperResponse } from "../../../src/features/ai/service/datamapper/types";
import { DataMapperRequest, DataMapperResponse, FileData, processDataMapperInput } from "../../../src/features/ai/service/datamapper/context_api";
import { getAskResponse } from "../../../src/features/ai/service/ask/ask";
import { MappingFileRecord} from "./types";
import { generateAutoMappings, generateRepairCode } from "../../../src/features/ai/service/datamapper/datamapper";
import { ArtifactNotificationHandler, ArtifactsUpdated } from "../../utils/project-artifacts-handler";

// const BACKEND_BASE_URL = BACKEND_URL.replace(/\/v2\.0$/, "");
//TODO: Temp workaround as custom domain seem to block file uploads
const CONTEXT_UPLOAD_URL_V1 = "https://e95488c8-8511-4882-967f-ec3ae2a0f86f-prod.e1-us-east-azure.choreoapis.dev/ballerina-copilot/context-upload-api/v1.0";
// const CONTEXT_UPLOAD_URL_V1 = BACKEND_BASE_URL + "/context-api/v1.0";
// const ASK_API_URL_V1 = BACKEND_BASE_URL + "/ask-api/v1.0";

export class AIPanelAbortController {
    private static instance: AIPanelAbortController;
    private abortController: AbortController;

    private constructor() {
        this.abortController = new AbortController();
    }

    public static getInstance(): AIPanelAbortController {
        if (!AIPanelAbortController.instance) {
            AIPanelAbortController.instance = new AIPanelAbortController();
        }
        return AIPanelAbortController.instance;
    }

    public get signal(): AbortSignal {
        return this.abortController.signal;
    }

    public abort(): void {
        this.abortController.abort();
        // Create a new AbortController for the next operation
        this.abortController = new AbortController();
    }
}

// Common functions

// Aborts the current AI panel operation
export function handleStop() {
    AIPanelAbortController.getInstance().abort();
}

// Checks if an error object has both 'code' and 'message' properties
export function isErrorCode(error: any): boolean {
    return error.hasOwnProperty("code") && error.hasOwnProperty("message");
}

// Adds file changes to the workspace and waits for artifact update notifications
export async function addToIntegration(workspaceFolderPath: string, fileChanges: FileChanges[]) {
    const formattedWorkspaceEdit = new WorkspaceEdit();
    const nonBalFiles: FileChanges[] = [];
    let isBalFileAdded = false;
    for (const fileChange of fileChanges) {
        let balFilePath = path.join(workspaceFolderPath, fileChange.filePath);
        const fileUri = Uri.file(balFilePath);
        if (!fileChange.filePath.endsWith('.bal')) {
            nonBalFiles.push(fileChange);
            continue;
        }
        isBalFileAdded = true;

        formattedWorkspaceEdit.createFile(fileUri, { ignoreIfExists: true });

        formattedWorkspaceEdit.replace(
            fileUri,
            new Range(
                new Position(0, 0),
                new Position(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
            ),
            fileChange.content
        );
    }

    // Apply all formatted changes at once
    await workspace.applyEdit(formattedWorkspaceEdit);
    await workspace.saveAll();

    // Write non ballerina files separately as ls doesn't need to be notified of those changes
    for (const fileChange of nonBalFiles) {
        let absoluteFilePath = path.join(workspaceFolderPath, fileChange.filePath);
        const directory = path.dirname(absoluteFilePath);
        if (!fs.existsSync(directory)) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.writeFileSync(absoluteFilePath, fileChange.content, 'utf8');
    }
    return new Promise((resolve, reject) => {
        if (!isBalFileAdded) {
            resolve([]);
        }
        // Get the artifact notification handler instance
        const notificationHandler = ArtifactNotificationHandler.getInstance();
        // Subscribe to artifact updated notifications
        let unsubscribe = notificationHandler.subscribe(ArtifactsUpdated.method, undefined, async (payload) => {
            clearTimeout(timeoutId);
            resolve(payload.data);
            unsubscribe();
        });

        // Set a timeout to reject if no notification is received within 10 seconds
        const timeoutId = setTimeout(() => {
            console.log("No artifact update notification received within 10 seconds");
            reject(new Error("Operation timed out. Please try again."));
            unsubscribe();
        }, 10000);

        // Clear the timeout when notification is received
        const originalUnsubscribe = unsubscribe;
        unsubscribe = () => {
            clearTimeout(timeoutId);
            originalUnsubscribe();
        };
    });
}

// Converts an attachment to file data format
async function attatchmentToFileData(file: Attachment): Promise<FileData> {
    return {
        fileName: file.name,
        content: file.content
    };
}

// Datamapper related functions

// Processes data mapper model and optional mapping file to generate mapping expressions
export async function processMappings(
    request: DMModel,
    file?: Attachment
): Promise<Mapping[]> {
    let cleanedResponse: DataMapperModelResponse = {
        mappingsModel: request as DMModel
    };
    if (file) {
        const mappedResult = await mappingFileDataMapperModel(file, cleanedResponse);
        cleanedResponse = mappedResult as DataMapperModelResponse;
    }

    const codeObject = await getDatamapperCode(cleanedResponse);
    return codeObject.map(mapping => ({
        output: mapping.output,
        expression: mapping.expression,
        isFunctionCall: (mapping as any).requiresCustomFunction,
        functionContent: mapping.functionContent
    }));
}

// Processes a mapping instruction file and merges it with the existing data mapper model
export async function mappingFileDataMapperModel(file: Attachment, dataMapperResponse: DataMapperModelResponse): Promise<DataMapperModelResponse> {
    if (!file) { return dataMapperResponse; }
    const fileData = await attatchmentToFileData(file);
    const params: DataMapperRequest = {
        file: fileData,
        processType: "mapping_instruction"
    };
    const resp: DataMapperResponse = await processDataMapperInput(params);
    let mappingFile: MappingFileRecord = JSON.parse(resp.fileContent) as MappingFileRecord;

    return {
        ...dataMapperResponse,
        mappingsModel: {
            ...dataMapperResponse.mappingsModel,
            mapping_fields: mappingFile.mapping_fields
        }
    };
}

// Generates data mapper code from the data mapper model response
async function getDatamapperCode(dataMapperResponse: DataMapperModelResponse): Promise<Mapping[]> {
    try {
        const response: DatamapperResponse = await generateAutoMappings(dataMapperResponse);
        return response.mappings;
    } catch (error) {
        console.error(error);
        throw error;
    }
}

// Processes a repair request and returns the repaired source files
export async function processRepair(repairRequest: repairCodeRequest): Promise<SourceFile[]> {
    try {
        const response = await generateRepairCode(repairRequest);
        return response.repairedFiles;
    } catch (error) {
        console.error(error);
        throw error;
    }
}

// Type Creator related functions

// Extracts type definitions from a file attachment
export async function typesFileParameterDefinitions(file: Attachment): Promise<string> {
    if (!file) { throw new Error("File is undefined"); }

    const fileData = await attatchmentToFileData(file);
    const params: DataMapperRequest = {
        file: fileData,
        processType: "records"
    };
    const resp: DataMapperResponse = await processDataMapperInput(params);
    return resp.fileContent;
}

// Natural language programming related functions

// Analyzes a requirements document and returns the specification
export async function requirementsSpecification(filepath: string): Promise<string> {
    if (!filepath) {
        throw new Error("File is undefined");
    }
    const fileData = await attatchmentToFileData({
        name: path.basename(filepath),
        content: getBase64FromFile(filepath), status: AttachmentStatus.UnknownError
    });
    const params: DataMapperRequest = {
        file: fileData,
        processType: "requirements",
        isRequirementAnalysis: true
    };
    const resp: DataMapperResponse = await processDataMapperInput(params);
    return resp.fileContent;
}

// Reads a file and converts it to base64 encoding
function getBase64FromFile(filePath: string) {
    const fileBuffer = fs.readFileSync(filePath);
    return fileBuffer.toString('base64');
}

// Feedback related functions

// Removes unnecessary fields from diagnostic entries
export function cleanDiagnosticMessages(entries: DiagnosticEntry[]): DiagnosticEntry[] {
    return entries.map(entry => ({
        code: entry.code || "",
        message: entry.message,
    }));
}

// Ask related functions

// Searches documentation and formats the response with reference sources
export async function searchDocumentation(message: string): Promise<string> {
    const resp = await getAskResponse(message,);
    const finalResponse = resp.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
    const referenceSources = resp.references;
    let responseContent: string;
    if (referenceSources.length > 0) {
        responseContent = `${finalResponse}  \nreference sources:  \n${referenceSources.join('  \n')}`;
    } else {
        responseContent = finalResponse;
    }

    return responseContent;
}

// Filters and formats documentation response from API response
export async function filterDocumentation(resp: Response): Promise<string> {
    let responseContent: string;
    if (resp.status == 200 || resp.status == 201) {
        const data = (await resp.json()) as any;
        console.log("data", data.response);
        const finalResponse = await (data.response.content).replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        const referenceSources = data.response.references;
        if (referenceSources.length > 0) {
            responseContent = `${finalResponse}  \nreference sources:  \n${referenceSources.join('  \n')}`;
        } else {
            responseContent = finalResponse;
        }
        return responseContent;
    }
    throw new Error(AIChatError.UNKNOWN_CONNECTION_ERROR);
}
