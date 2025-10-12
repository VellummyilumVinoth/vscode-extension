// Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com/) All Rights Reserved.

// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at

// http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { CoreMessage, generateObject } from "ai";
import { getAnthropicClient, ANTHROPIC_SONNET_4, ANTHROPIC_SONNET_4_5 } from "../connection";
import {
    DatamapperResponse,
    MappingFields,
    DataMappingResponse,
    RepairedFiles,
} from "./types";
import { GeneratedMappingSchema, RepairedSourceFilesSchema } from "./schema";
import { AIPanelAbortController } from "../../../../../src/rpc-managers/ai-panel/utils";
import { DataMapperModelResponse, DMModel, Mapping, repairCodeRequest, SourceFile, DiagnosticList, ImportInfo } from "@wso2/ballerina-core";
import { getDataMappingPrompt } from "./dataMappingPrompt";
import { getBallerinaCodeRepairPrompt } from "./codeRepairPrompt";

// =============================================================================
// ENHANCED MAIN ORCHESTRATOR FUNCTION
// =============================================================================

// Generates AI-powered data mappings with retry logic for handling failures
async function generateDataMappings(payload: DataMapperModelResponse): Promise<DatamapperResponse> {
    const maxRetries = 3;
    let retries = 0;
    let lastError: Error;

    while (retries < maxRetries) {
        if (retries > 0) {
            console.debug("Retrying to generate mappings for the payload.");
        }

        try {
            // Extract existing mapping field hints
            const mappingFields: { [key: string]: MappingFields } = payload.mappingsModel.mapping_fields || {};

            // Generate AI-powered mappings using Claude
            const generatedMappings = await generateClaudeMappings((payload.mappingsModel as DMModel), payload.mappingsModel.mappings, mappingFields);

            if (Object.keys(generatedMappings).length === 0) {
                const error = new Error("No valid fields were identified for mapping between the given input and output records.");
                lastError = error;
                retries += 1;
                continue;
            }

            return { mappings: generatedMappings };

        } catch (error) {
            console.error(`Error occurred while generating mappings: ${error}`);
            lastError = error as Error;
            retries += 1;
            continue;
        }
    }
    throw lastError;
}

// Calls Claude AI to generate mappings based on data model, user mappings, and mapping hints
async function generateClaudeMappings(
    DataMapperModel: DMModel,
    userMappings: DataMappingResponse[],
    mappingTips: { [key: string]: MappingFields }
): Promise<Mapping[]> {
    const prompt = getDataMappingPrompt(
        JSON.stringify(DataMapperModel),
        JSON.stringify(userMappings),
        JSON.stringify(mappingTips)
    );

    const messages: CoreMessage[] = [
        { role: "user", content: prompt }
    ];

    try {
        const { object } = await generateObject({
            model: await getAnthropicClient(ANTHROPIC_SONNET_4_5),
            maxTokens: 8192,
            temperature: 0,
            messages: messages,
            schema: GeneratedMappingSchema,
            abortSignal: AIPanelAbortController.getInstance().signal,
        });

        const generatedMappings = object.generatedMappings as Mapping[];
        return generatedMappings;
    } catch (error) {
        console.error("Failed to parse response:", error);
        throw new Error(`Failed to parse mapping response: ${error}`);
    }
}

// Uses Claude AI to repair Ballerina source files based on diagnostics and import information
async function generateClaudeRepairedFiles(
    sourceFiles: SourceFile[],
    diagnostics: DiagnosticList,
    imports: ImportInfo[]
): Promise<SourceFile[]> {
    const prompt = getBallerinaCodeRepairPrompt(
        JSON.stringify(sourceFiles),
        JSON.stringify(diagnostics),
        JSON.stringify(imports)
    );

    const messages: CoreMessage[] = [
        { role: "user", content: prompt }
    ];

    try {
        const { object } = await generateObject({
            model: await getAnthropicClient(ANTHROPIC_SONNET_4_5),
            maxTokens: 8192,
            temperature: 0,
            messages: messages,
            schema: RepairedSourceFilesSchema,
            abortSignal: AIPanelAbortController.getInstance().signal,
        });

        return object.repairedFiles as SourceFile[];
    } catch (error) {
        console.error("Failed to parse response:", error);
        throw new Error(`Failed to parse repaired files response: ${error}`);
    }
}

// =============================================================================
// MAIN EXPORT FUNCTION
// =============================================================================

// Main entry point for generating automatic data mappings from payload
export async function generateAutoMappings(payload?: DataMapperModelResponse): Promise<DatamapperResponse> {
    if (!payload) {
        throw new Error("Payload is required for generating auto mappings");
    }
    try {
        return await generateDataMappings(payload);
    } catch (error) {
        console.error(`Error generating auto mappings: ${error}`);
        throw error;
    }
}

// Generates repaired Ballerina code by fixing diagnostics with retry logic
export async function generateRepairCode(payload?: repairCodeRequest): Promise<RepairedFiles> {
    if (!payload) {
        throw new Error("Payload is required for generating repair code");
    }

    const maxRetries = 3;
    let retries = 0;
    let lastError: Error;

    while (retries < maxRetries) {
        if (retries > 0) {
            console.debug("Retrying to generate repair code for the payload.");
        }

        try {
            // Generate AI-powered repaired source files using Claude
            const repairedFiles = await generateClaudeRepairedFiles(payload.sourceFiles, payload.diagnostics, payload.imports);

            if (!repairedFiles || repairedFiles.length === 0) {
                const error = new Error("No repaired files were generated. Unable to fix the provided source code.");
                lastError = error;
                retries += 1;
                continue;
            }

            return { repairedFiles };

        } catch (error) {
            console.error(`Error occurred while generating repaired code: ${error}`);
            lastError = error as Error;
            retries += 1;
            continue;
        }
    }
    
    throw lastError!;
}
