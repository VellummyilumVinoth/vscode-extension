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

import { ArrayTypeDesc, FunctionDefinition, ModulePart, QualifiedNameReference, RequiredParam, STKindChecker } from "@wso2/syntax-tree";
import { ErrorCode, FormField, STModification, SyntaxTree, Attachment, AttachmentStatus, RecordDefinitonObject, ParameterMetadata, ParameterDefinitions, MappingFileRecord, keywords, AIMachineEventType, DiagnosticEntry, InlineDataMapperModelResponse, NestedFieldDescriptor, InputMetadata, OutputMetadata, IntermediateMapping, MappingsResponse, MappingData, FieldMetadata, ParameterField, ProcessCombinedKeyResult, ProcessParentKeyResult, VisitorContext } from "@wso2/ballerina-core";
import { UNKNOWN_ERROR } from '../../views/ai-panel/errorCodes';
import { StateMachine } from "../../stateMachine";
import {
    ENDPOINT_REMOVED,
    INVALID_PARAMETER_TYPE,
    INVALID_PARAMETER_TYPE_MULTIPLE_ARRAY,
    PARSING_ERROR,
    TIMEOUT,
    NOT_LOGGED_IN,
    SERVER_ERROR,
    TOO_MANY_REQUESTS,
    INVALID_RECORD_UNION_TYPE
} from "../../views/ai-panel/errorCodes";
import path from "path";
import * as fs from 'fs';
import { BACKEND_URL } from "../../features/ai/utils";
import { getAccessToken, getRefreshedAccessToken } from "../../../src/utils/ai/auth";
import { AIStateMachine } from "../../../src/views/ai-panel/aiMachine";
import { AIChatError } from "./utils/errors";
import { ArrayEnumUnionType, ArrayRecordType, MetadataType, Operation, PrimitiveType, RecordType, UnionEnumIntersectionType } from "./constants";

const BACKEND_BASE_URL = (BACKEND_URL || "").replace(/\/v2\.0$/, "");
//TODO: Temp workaround as custom domain seem to block file uploads
const CONTEXT_UPLOAD_URL_V1 = "https://e95488c8-8511-4882-967f-ec3ae2a0f86f-prod.e1-us-east-azure.choreoapis.dev/ballerina-copilot/context-upload-api/v1.0";
// const CONTEXT_UPLOAD_URL_V1 = BACKEND_BASE_URL + "/context-api/v1.0";
const ASK_API_URL_V1 = BACKEND_BASE_URL + "/ask-api/v1.0";

export const REQUEST_TIMEOUT = 2000000;
let abortController = new AbortController();

// Common functions
function determineMimeType(fileName: string): string {
    const extension = fileName.split(".").pop()?.toLowerCase();
    switch (extension) {
        case "pdf": return "application/pdf";
        case "txt": return "text/plain";
        case "jpg":
        case "jpeg": return "image/jpeg";
        case "png": return "image/png";
        case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        case "doc": return "application/msword";
        case "heic":
        case "heif": return "image/heif";
        default: return "application/octet-stream";
    }
}

function convertBase64ToBlob(file: Attachment): Blob | null {
    try {
        const { content: base64Content, name: fileName } = file;
        const binaryString = atob(base64Content);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const mimeType = determineMimeType(fileName);
        return new Blob([bytes], { type: mimeType });
    } catch (error) {
        console.error("Error converting Base64 to Blob", error);
        return null;
    }
}

export async function fetchWithToken(url: string, options: RequestInit) {
    const accessToken = await getAccessToken();
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': 'Ballerina-VSCode-Plugin',
    };
    let response = await fetch(url, options);
    console.log("Response status: ", response.status);
    if (response.status === 401) {
        console.log("Token expired. Refreshing token...");
        const newToken = await getRefreshedAccessToken();
        if (newToken) {
            options.headers = {
                ...options.headers,
                'Authorization': `Bearer ${newToken}`,
            };
            response = await fetch(url, options);
        } else {
            AIStateMachine.service().send(AIMachineEventType.LOGOUT);
            return;
        }
    }
    return response;
}

export async function fetchWithTimeout(url: string | URL | Request, options: RequestInit, timeout = 100000): Promise<Response | ErrorCode> {
    abortController = new AbortController();
    const id = setTimeout(() => abortController.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: abortController.signal });
        clearTimeout(id);
        return response;
    } catch (error: any) {
        if (error.name === 'AbortError') {
            return TIMEOUT;
        } else {
            console.error(error);
            return SERVER_ERROR;
        }
    }
}

async function filterMappingResponse(resp: Response): Promise<string | ErrorCode> {
    if (resp.status == 200 || resp.status == 201) {
        const data = (await resp.json()) as any;
        return data.file_content;
    }
    if (resp.status == 404) {
        return ENDPOINT_REMOVED;
    }
    if (resp.status == 400) {
        const data = (await resp.json()) as any;
        console.log(data);
        return PARSING_ERROR;
    } if (resp.status == 429) {
        return TOO_MANY_REQUESTS;
    }
    if (resp.status == 500) {
        return SERVER_ERROR;
    } else {
        //TODO: Handle more error codes
        return { code: 4, message: `An unknown error occured. ${resp.statusText}.` };
    }
}

const isPrimitiveType = (type: string): boolean => {
    return Object.values(PrimitiveType).includes(type as PrimitiveType);
};

const isUnionEnumIntersectionType = (type: string): boolean => {
    return Object.values(UnionEnumIntersectionType).includes(type as UnionEnumIntersectionType);
};

const isRecordType = (type: string): boolean => {
    return Object.values(RecordType).includes(type as RecordType);
};

const isArrayRecord = (type: string): boolean => {
    return Object.values(ArrayRecordType).includes(type as ArrayRecordType);
};

const isArrayEnumUnion = (type: string): boolean => {
    return Object.values(ArrayEnumUnionType).includes(type as ArrayEnumUnionType);
};

// Datamapper Related Logic
export async function processMappings(
    fnSt: FunctionDefinition,
    fileUri: string,
    file?: Attachment
): Promise<SyntaxTree | ErrorCode> {
    let result = await getParamDefinitions(fnSt, fileUri);
    if (isErrorCode(result)) {
        return result as ErrorCode;
    }
    let parameterDefinitions = (result as ParameterDefinitions).parameterMetadata;
    const isErrorExists = (result as ParameterDefinitions).errorStatus;

    if (file) {
        let mappedResult = await mappingFileParameterDefinitions(file, parameterDefinitions);
        if (isErrorCode(mappedResult)) {
            return mappedResult as ErrorCode;
        }
        parameterDefinitions = mappedResult as ParameterMetadata;
    }

    const codeObject = await getDatamapperCode(parameterDefinitions);
    if (isErrorCode(codeObject) || Object.keys(codeObject).length === 0) {
        return codeObject as ErrorCode;
    }

    const { recordString, isCheckError } = await constructRecord(codeObject as { [key: string]: string });
    let codeString: string;
    const parameter = fnSt.functionSignature.parameters[0] as RequiredParam;
    const paramName = parameter.paramName.value;
    const formattedRecordString = recordString.startsWith(":") ? recordString.substring(1) : recordString;

    let returnType = fnSt.functionSignature.returnTypeDesc.type;

    if (STKindChecker.isUnionTypeDesc(returnType)) {
        const { leftTypeDesc: leftType, rightTypeDesc: rightType } = returnType;

        if (STKindChecker.isArrayTypeDesc(leftType) || STKindChecker.isArrayTypeDesc(rightType)) {
            codeString = isCheckError && !isErrorExists
                ? `|error => from var ${paramName}Item in ${paramName}\n select ${formattedRecordString};`
                : `=> from var ${paramName}Item in ${paramName}\n select ${formattedRecordString};`;
        } else {
            codeString = isCheckError && !isErrorExists ? `|error => ${recordString};` : `=> ${recordString};`;
        }
    } else if (STKindChecker.isArrayTypeDesc(returnType)) {
        codeString = isCheckError
            ? `|error => from var ${paramName}Item in ${paramName}\n select ${formattedRecordString};`
            : `=> from var ${paramName}Item in ${paramName}\n select ${formattedRecordString};`;
    } else {
        codeString = isCheckError ? `|error => ${recordString};` : `=> ${recordString};`;
    }

    const modifications: STModification[] = [];
    modifications.push({
        type: "INSERT",
        config: { STATEMENT: codeString },
        endColumn: fnSt.functionBody.position.endColumn,
        endLine: fnSt.functionBody.position.endLine,
        startColumn: fnSt.functionBody.position.startColumn,
        startLine: fnSt.functionBody.position.startLine,
    });

    const stModifyResponse = await StateMachine.langClient().stModify({
        astModifications: modifications,
        documentIdentifier: {
            uri: fileUri
        }
    });

    return stModifyResponse as SyntaxTree;
}

export async function getParamDefinitions(
    fnSt: FunctionDefinition,
    fileUri: string
): Promise<ParameterDefinitions | ErrorCode> {
    const inputs: NestedFieldDescriptor = {};
    const inputMetadata: InputMetadata = {};
    let output: NestedFieldDescriptor = {};
    let outputMetadata: OutputMetadata = {};
    let hasArrayParams = false;
    let arrayParams = 0;
    let isErrorExists = false;

    for (const parameter of fnSt.functionSignature.parameters) {
        if (!STKindChecker.isRequiredParam(parameter)) { continue; }

        const param = parameter as RequiredParam;
        const paramName = param.paramName.value;
        let paramType = "";

        if (STKindChecker.isArrayTypeDesc(param.typeName)) { arrayParams++; }

        const symbolKind = param.typeData.typeSymbol.typeKind;
        paramType = symbolKind === "array"
            ? param.typeName.source
            : symbolKind === "typeReference"
                ? param.typeData.typeSymbol.name
                : param.typeName.source;

        const position = STKindChecker.isQualifiedNameReference(param.typeName)
            ? {
                line: (param.typeName as QualifiedNameReference).identifier.position.startLine,
                offset: (param.typeName as QualifiedNameReference).identifier.position.startColumn,
            }
            : STKindChecker.isArrayTypeDesc(param.typeName) &&
                STKindChecker.isQualifiedNameReference((param.typeName as ArrayTypeDesc).memberTypeDesc)
                ? {
                    line: ((param.typeName as ArrayTypeDesc).memberTypeDesc as QualifiedNameReference).identifier.position.startLine,
                    offset: ((param.typeName as ArrayTypeDesc).memberTypeDesc as QualifiedNameReference).identifier.position.startColumn,
                }
                : {
                    line: parameter.position.startLine,
                    offset: parameter.position.startColumn,
                };
        const inputTypeDefinition = await StateMachine.langClient().getTypeFromSymbol({
            documentIdentifier: { uri: fileUri },
            positions: [position]
        });

        if ('types' in inputTypeDefinition && inputTypeDefinition.types.length > 1) {
            return INVALID_PARAMETER_TYPE;
        }

        if ('types' in inputTypeDefinition && !inputTypeDefinition.types[0].hasOwnProperty('type')) {
            if (STKindChecker.isQualifiedNameReference(parameter.typeName)) {
                throw new Error(`"${parameter.typeName["identifier"].value}" does not exist in the package "${parameter.typeName["modulePrefix"].value}".`);
            }
            return INVALID_PARAMETER_TYPE;
        }

        const inputType = inputTypeDefinition["types"]?.[0]?.type;

        if (inputType?.typeName === "union" && inputType.members?.some(m => m.fields?.length > 0)) {
            return INVALID_RECORD_UNION_TYPE;
        }

        let inputDefinition: ErrorCode | RecordDefinitonObject;

        if (inputType?.fields) {
            inputDefinition = navigateTypeInfo(inputType.fields, false);
        } else {
            const singleFieldType = inputType;
            inputDefinition = {
                recordFields: {
                    [paramName]: {
                        type: singleFieldType.typeName,
                        comment: "",
                    },
                },
                recordFieldsMetadata: {
                    [paramName]: {
                        typeName: singleFieldType.typeName,
                        type: singleFieldType.typeName,
                        typeInstance: paramName,
                        nullable: false,
                        optional: false,
                    },
                },
            };
        }

        if (isErrorCode(inputDefinition)) {
            return inputDefinition as ErrorCode;
        }
        const recordDef = inputDefinition as RecordDefinitonObject;

        inputs[paramName] = recordDef.recordFields;
        inputMetadata[paramName] = {
            isArrayType: STKindChecker.isArrayTypeDesc(parameter.typeName),
            parameterName: paramName,
            parameterType: paramType,
            type: STKindChecker.isArrayTypeDesc(parameter.typeName) ? "record[]" : "record",
            fields: recordDef.recordFieldsMetadata,
        };

        if (STKindChecker.isArrayTypeDesc(parameter.typeName)) {
            hasArrayParams = true;
        }
    }

    // Handle return type logic
    const returnType = fnSt.functionSignature.returnTypeDesc.type;

    if (STKindChecker.isUnionTypeDesc(returnType)) {
        const [leftType, rightType] = [returnType.leftTypeDesc, returnType.rightTypeDesc];

        const isValidUnion =
            (STKindChecker.isArrayTypeDesc(leftType) && STKindChecker.isErrorTypeDesc(rightType) &&
                STKindChecker.isSimpleNameReference(leftType.memberTypeDesc)) ||
            (STKindChecker.isArrayTypeDesc(rightType) && STKindChecker.isErrorTypeDesc(leftType) &&
                STKindChecker.isSimpleNameReference(rightType.memberTypeDesc)) ||
            (STKindChecker.isErrorTypeDesc(leftType) && STKindChecker.isSimpleNameReference(rightType)) ||
            (STKindChecker.isErrorTypeDesc(rightType) && STKindChecker.isSimpleNameReference(leftType));

        if (!isValidUnion) { return INVALID_PARAMETER_TYPE; }
        isErrorExists = true;
    } else if (STKindChecker.isArrayTypeDesc(returnType)) {
        if (arrayParams > 1 || !hasArrayParams) { return INVALID_PARAMETER_TYPE_MULTIPLE_ARRAY; }
        const memberDesc = returnType.memberTypeDesc;
        if (!(STKindChecker.isSimpleNameReference(memberDesc) || STKindChecker.isQualifiedNameReference(memberDesc))) {
            return INVALID_PARAMETER_TYPE;
        }
    } else {
        if (!(STKindChecker.isSimpleNameReference(returnType) || STKindChecker.isQualifiedNameReference(returnType))) {
            return INVALID_PARAMETER_TYPE;
        }
    }

    // Determine return type position
    const returnTypePosition = STKindChecker.isUnionTypeDesc(returnType)
        ? {
            line: STKindChecker.isErrorTypeDesc(returnType.leftTypeDesc)
                ? returnType.rightTypeDesc.position.startLine
                : returnType.leftTypeDesc.position.startLine,
            offset: STKindChecker.isErrorTypeDesc(returnType.leftTypeDesc)
                ? returnType.rightTypeDesc.position.startColumn
                : returnType.leftTypeDesc.position.startColumn
        }
        : STKindChecker.isArrayTypeDesc(returnType) && STKindChecker.isQualifiedNameReference(returnType.memberTypeDesc)
            ? {
                line: returnType.memberTypeDesc.identifier.position.startLine,
                offset: returnType.memberTypeDesc.identifier.position.startColumn
            }
            : STKindChecker.isQualifiedNameReference(returnType)
                ? {
                    line: returnType.identifier.position.startLine,
                    offset: returnType.identifier.position.startColumn
                }
                : {
                    line: returnType.position.startLine,
                    offset: returnType.position.startColumn
                };

    const outputTypeDefinition = await StateMachine.langClient().getTypeFromSymbol({
        documentIdentifier: { uri: fileUri },
        positions: [returnTypePosition]
    });

    if ('types' in outputTypeDefinition && !outputTypeDefinition.types[0].hasOwnProperty('type')) {
        if (STKindChecker.isQualifiedNameReference(returnType)) {
            throw new Error(`"${returnType["identifier"].value}" does not exist in the package "${returnType["modulePrefix"].value}".`);
        }
        return INVALID_PARAMETER_TYPE;
    }

    const outputType = outputTypeDefinition["types"]?.[0]?.type;
    if (outputType?.typeName === "union" && outputType.members?.some(m => m.fields)) {
        return INVALID_RECORD_UNION_TYPE;
    }

    const outputDef = navigateTypeInfo(outputType?.fields ?? {}, false);
    if (isErrorCode(outputDef)) { return outputDef as ErrorCode; }
    output = (outputDef as RecordDefinitonObject).recordFields;
    outputMetadata = (outputDef as RecordDefinitonObject).recordFieldsMetadata;

    const response: ParameterMetadata = {
        inputs,
        output,
        inputMetadata,
        outputMetadata,
    };

    return {
        parameterMetadata: response,
        errorStatus: isErrorExists
    };
}

export function navigateTypeInfo(
    typeInfos: FormField[],
    isNill: boolean
): RecordDefinitonObject | ErrorCode {
    const context: VisitorContext = {
        recordFields: {},
        recordFieldsMetadata: {},
        memberRecordFields: {},
        memberFieldsMetadata: {},
        fieldMetadata: {} as FieldMetadata,
        isNill,
        isNullable: false,
        isArray: false,
        memberName: '',
        isRecord: false,
        isArrayNullable: false,
        isRecordNullable: false,
        isSimple: false,
        isUnion: false
    };

    const visitor = new TypeInfoVisitorImpl();

    for (const field of typeInfos) {
        visitor.visitField(field, context);
    }

    return {
        recordFields: context.recordFields,
        recordFieldsMetadata: context.recordFieldsMetadata
    };
}

//Define interfaces for the visitor pattern
interface TypeInfoVisitor {
    visitField(field: FormField, context: VisitorContext): void;
    visitMember(member: FormField, context: VisitorContext): { typeName: string, member: FormField };
    visitRecord(field: FormField, context: VisitorContext): void;
    visitUnionOrIntersection(field: FormField, context: VisitorContext): void;
    visitArray(field: FormField, context: VisitorContext): void;
    visitEnum(field: FormField, context: VisitorContext): void;
    visitPrimitive(field: FormField, context: VisitorContext): void;
}

// Implementation of the visitor
class TypeInfoVisitorImpl implements TypeInfoVisitor {
    constructor() { }

    visitField(field: FormField, context: VisitorContext): void {
        this.resetContext(context);

        const typeName = field.typeName;
        if (!typeName) {
            this.handleTypeInfo(field, context);
            return;
        }

        switch (typeName) {
            case RecordType.RECORD:
                this.visitRecord(field, context);
                break;
            case UnionEnumIntersectionType.UNION:
            case UnionEnumIntersectionType.INTERSECTION:
                this.visitUnionOrIntersection(field, context);
                break;
            case "array":
                this.visitArray(field, context);
                break;
            case UnionEnumIntersectionType.ENUM:
                this.visitEnum(field, context);
                break;
            default:
                this.visitPrimitive(field, context);
                break;
        }
    }

    visitMember(member: FormField, context: VisitorContext): { typeName: string, member: FormField } {
        let typeName: string;
        if (member.typeName === RecordType.RECORD && member.fields) {
            typeName = this.handleRecordMember(member, context);
        } else if (member.typeName === "array") {
            const result = this.handleArrayMember(member, context);
            typeName = result.typeName;
            member = result.member;
        } else if ([UnionEnumIntersectionType.UNION,
        UnionEnumIntersectionType.INTERSECTION,
        UnionEnumIntersectionType.ENUM].includes(member.typeName as UnionEnumIntersectionType)) {
            typeName = this.handleCompositeMember(member, context);
        } else if (member.typeName === "()") {
            typeName = this.handleNullMember(member, context);
        } else {
            typeName = this.handleSimpleMember(member, context);
        }
        return { typeName, member };
    }

    visitRecord(field: FormField, context: VisitorContext): void {
        const temporaryRecord = navigateTypeInfo(field.fields, false);
        context.isRecord = true;

        const fieldName = getBalRecFieldName(field.name);
        context.recordFields[fieldName] = (temporaryRecord as RecordDefinitonObject).recordFields;
        context.recordFieldsMetadata[fieldName] = {
            nullable: context.isNill,
            optional: field.optional,
            type: RecordType.RECORD,
            typeInstance: fieldName,
            typeName: field.typeName,
            fields: (temporaryRecord as RecordDefinitonObject).recordFieldsMetadata
        };
    }

    visitUnionOrIntersection(field: FormField, context: VisitorContext): void {
        let memberTypeNames: string[] = [];
        let resolvedTypeName: string = "";

        // Check for record fields in union members and handle appropriately
        this.processUnionMembers(field.members, context);

        for (const member of field.members) {
            const result = this.visitMember(member, context);
            memberTypeNames.push(result.typeName);
            if (Object.keys(result.member).length === 0) {
                field.members = [];
                break;
            }
        }

        if (field.members.length === 0) {
            context.memberRecordFields = {};
            context.memberFieldsMetadata = {};
            return;
        }

        resolvedTypeName = this.getResolvedTypeName(field.typeName, memberTypeNames);

        this.buildFieldMetadata(field, resolvedTypeName, context);
        this.setFieldAndMetadata(field, resolvedTypeName, context);
    }

    visitArray(field: FormField, context: VisitorContext): void {
        if (field.memberType.hasOwnProperty("members") &&
            [UnionEnumIntersectionType.UNION,
            UnionEnumIntersectionType.INTERSECTION,
            UnionEnumIntersectionType.ENUM].includes(field.memberType.typeName as UnionEnumIntersectionType)) {

            // Handle array with union/intersection/enum member type
            this.processUnionMembers(field.memberType.members, context);

            if (field.memberType.members.length === 0) {
                context.memberRecordFields = {};
                context.memberFieldsMetadata = {};
                return;
            }

            this.handleArrayWithCompositeType(field, context);
        } else if (field.memberType.hasOwnProperty("fields") && field.memberType.typeName === RecordType.RECORD) {
            this.handleArrayWithRecordType(field, context);
        } else {
            this.handleSimpleArray(field, context);
        }
    }

    visitEnum(field: FormField, context: VisitorContext): void {
        let memberTypeNames: string[] = [];

        for (const member of field.members) {
            const result = this.visitMember(member, context);
            memberTypeNames.push(result.typeName);
        }

        const resolvedTypeName = memberTypeNames.join("|");

        this.buildFieldMetadata(field, resolvedTypeName, context);
        this.setFieldAndMetadata(field, resolvedTypeName, context);
    }

    visitPrimitive(field: FormField, context: VisitorContext): void {
        const typeName = field.typeName;

        if (field.hasOwnProperty("name")) {
            const fieldName = getBalRecFieldName(field.name);
            context.recordFields[fieldName] = { type: typeName, comment: "" };
            context.recordFieldsMetadata[fieldName] = {
                typeName: typeName,
                type: typeName,
                typeInstance: fieldName,
                nullable: context.isNill,
                optional: field.optional
            };
        } else {
            context.recordFields[typeName] = { type: PrimitiveType.STRING, comment: "" };
            context.recordFieldsMetadata[typeName] = {
                typeName: typeName,
                type: PrimitiveType.STRING,
                typeInstance: typeName,
                nullable: context.isNill,
                optional: field.optional
            };
        }
    }

    private handleTypeInfo(field: FormField, context: VisitorContext): void {
        const fieldName = getBalRecFieldName(field.name);
        context.recordFields[fieldName] = { type: field.typeInfo.name, comment: "" };
        context.recordFieldsMetadata[fieldName] = {
            typeName: field.typeInfo.name,
            type: field.typeInfo.name,
            typeInstance: fieldName,
            nullable: context.isNill,
            optional: field.optional
        };
    }

    private handleRecordMember(member: FormField, context: VisitorContext): string {
        const temporaryRecord = navigateTypeInfo(member.fields, false);
        context.isRecord = true;
        let memberName: string;

        if (context.isUnion && member.hasOwnProperty("name")) {
            memberName = member.name;
            const fieldName = getBalRecFieldName(memberName);
            context.memberRecordFields[fieldName] = (temporaryRecord as RecordDefinitonObject).recordFields;
            context.memberFieldsMetadata[fieldName] = {
                nullable: context.isNill,
                optional: member.optional,
                type: RecordType.RECORD,
                typeInstance: fieldName,
                typeName: member.typeName,
                fields: (temporaryRecord as RecordDefinitonObject).recordFieldsMetadata
            };
        } else {
            memberName = RecordType.RECORD;
            context.memberRecordFields = {
                ...context.memberRecordFields,
                ...(temporaryRecord as RecordDefinitonObject).recordFields
            };
            context.memberFieldsMetadata = {
                ...context.memberFieldsMetadata,
                ...((temporaryRecord as RecordDefinitonObject).recordFieldsMetadata)
            };
        }

        return memberName;
    }

    private handleArrayMember(member: FormField, context: VisitorContext): { typeName: string, member: FormField } {
        context.isArray = true;
        let memberName: string;

        if (member.memberType.hasOwnProperty("fields") && member.memberType.typeName === "record") {
            const temporaryRecord = navigateTypeInfo(member.memberType.fields, false);
            memberName = `${member.memberType.typeName}[]`;
            context.memberRecordFields = {
                ...context.memberRecordFields,
                ...(temporaryRecord as RecordDefinitonObject).recordFields
            };
            context.memberFieldsMetadata = {
                ...context.memberFieldsMetadata,
                ...((temporaryRecord as RecordDefinitonObject).recordFieldsMetadata)
            };
        } else if (member.memberType.hasOwnProperty("members") &&
            [UnionEnumIntersectionType.UNION,
            UnionEnumIntersectionType.INTERSECTION,
            UnionEnumIntersectionType.ENUM].includes(member.memberType.typeName as UnionEnumIntersectionType)) {

            // Process union members to handle records appropriately
            this.processUnionMembers(member.memberType.members, context);

            if (member.memberType.members.length === 0) {
                memberName = "";
                member = {} as FormField;
            } else {
                memberName = this.handleArrayWithCompositeTypeMember(member, context);
            }
        } else if (member.memberType.hasOwnProperty("typeInfo")) {
            if (member.memberType.hasOwnProperty("name") && !member.memberType.hasOwnProperty("typeName")) {
                memberName = `${member.memberType.name}[]`;
            } else {
                memberName = ArrayRecordType.RECORD_ARRAY;
            }
        } else {
            memberName = `${member.memberType.typeName}[]`;
        }

        return { typeName: memberName, member };
    }

    private handleArrayWithCompositeTypeMember(member: FormField, context: VisitorContext): string {
        let memberTypes: string[] = [];
        const members = member.memberType.members;

        this.determineIfUnion(members, context);

        for (const innerMember of members) {
            const result = this.visitMember(innerMember, context);
            memberTypes.push(result.typeName);
        }

        context.isSimple = false;

        if (member.memberType.typeName === UnionEnumIntersectionType.INTERSECTION) {
            return `(${memberTypes.join("&")})[]`;
        } else {
            return `(${memberTypes.join("|")})[]`;
        }
    }

    private handleCompositeMember(member: FormField, context: VisitorContext): string {
        let memberTypeNames: string[] = [];

        for (const innerMember of member.members) {
            const result = this.visitMember(innerMember, context);
            memberTypeNames.push(result.typeName);
        }

        if (member.typeName === UnionEnumIntersectionType.INTERSECTION) {
            return `${memberTypeNames.join("&")}`;
        } else {
            return `${memberTypeNames.join("|")}`;
        }
    }

    private handleNullMember(member: FormField, context: VisitorContext): string {
        const memberName = member.typeName;

        if (context.isArray) {
            context.isArrayNullable = true;
        }
        if (context.isRecord) {
            context.isRecordNullable = true;
        }
        if (context.isSimple) {
            context.isNullable = true;
        }

        return memberName;
    }

    private handleSimpleMember(member: FormField, context: VisitorContext): string {
        context.isSimple = true;
        let memberName: string;

        if (member.hasOwnProperty("typeName")) {
            memberName = member.typeName;

            if (member.hasOwnProperty("name")) {
                this.addNamedSimpleMember(member, memberName, context);
            } else {
                this.addUnnamedSimpleMember(memberName, member, context);
            }
        } else {
            memberName = member.name;
        }

        return memberName;
    }

    private addNamedSimpleMember(member: FormField, memberName: string, context: VisitorContext): void {
        const fieldName = getBalRecFieldName(member.name);
        context.memberRecordFields = {
            ...context.memberRecordFields,
            [fieldName]: {
                type: memberName,
                comment: ""
            }
        };
        context.memberFieldsMetadata = {
            ...context.memberFieldsMetadata,
            [fieldName]: {
                typeName: memberName,
                type: memberName,
                typeInstance: fieldName,
                nullable: context.isNill,
                optional: member.optional
            }
        };
    }

    private addUnnamedSimpleMember(memberName: string, member: FormField, context: VisitorContext): void {
        // Check if typeName is not one of the BasicTypes types
        const BasicTypes = ["int", "string", "float", "boolean", "decimal", "readonly"];
        if (!BasicTypes.includes(memberName)) {
            const fieldName = getBalRecFieldName(memberName);
            context.memberFieldsMetadata = {
                ...context.memberFieldsMetadata,
                [fieldName]: {
                    typeName: fieldName,
                    type: fieldName,
                    typeInstance: fieldName,
                    nullable: context.isNill,
                    optional: member.optional
                }
            };
        }
    }

    private handleArrayWithCompositeType(field: FormField, context: VisitorContext): void {
        let memberTypeNames: string[] = [];

        for (const member of field.memberType.members) {
            const result = this.visitMember(member, context);
            memberTypeNames.push(result.typeName);
        }

        context.isArray = true;
        let resolvedTypeName: string = "";

        if (field.memberType.typeName === UnionEnumIntersectionType.INTERSECTION) {
            resolvedTypeName = `${memberTypeNames.join("&")}`;
        } else {
            resolvedTypeName = `${memberTypeNames.join("|")}`;
        }

        const fieldName = getBalRecFieldName(field.name);
        context.recordFields[fieldName] = Object.keys(context.memberRecordFields).length > 0
            ? context.memberRecordFields
            : { type: `(${resolvedTypeName})[]`, comment: "" };

        this.buildArrayFieldMetadata(field, resolvedTypeName, context);
    }

    private handleArrayWithRecordType(field: FormField, context: VisitorContext): void {
        const temporaryRecord = navigateTypeInfo(field.memberType.fields, false);
        const fieldName = getBalRecFieldName(field.name);
        context.recordFields[fieldName] = (temporaryRecord as RecordDefinitonObject).recordFields;
        context.isArray = true;
        context.isRecord = true;

        context.fieldMetadata = {
            optional: field.optional,
            typeName: ArrayRecordType.RECORD_ARRAY,
            type: ArrayRecordType.RECORD_ARRAY,
            typeInstance: fieldName,
            fields: (temporaryRecord as RecordDefinitonObject).recordFieldsMetadata
        };

        this.applyNullabilityToFieldMetadata(context);
        context.recordFieldsMetadata[field.name] = context.fieldMetadata as FieldMetadata;
    }

    private handleSimpleArray(field: FormField, context: VisitorContext): void {
        let typeName: string;

        if (field.memberType.hasOwnProperty("typeInfo")) {
            typeName = ArrayRecordType.RECORD_ARRAY;
        } else {
            typeName = `${field.memberType.typeName}[]`;
        }

        if (field.memberType.members && field.memberType.members.length === 0) {
            context.memberRecordFields = {};
            context.memberFieldsMetadata = {};
        } else {
            const fieldName = getBalRecFieldName(field.name);
            context.recordFields[fieldName] = { type: typeName, comment: "" };
            context.recordFieldsMetadata[fieldName] = {
                typeName: typeName,
                type: typeName,
                typeInstance: fieldName,
                nullable: context.isNill,
                optional: field.optional
            };
        }
    }

    private processUnionMembers(members: FormField[], context: VisitorContext): void {
        this.determineIfUnion(members, context);

        if (members.length > 2) {
            // If at least one member has fields, remove that field
            for (let i = members.length - 1; i >= 0; i--) {
                if (members[i].fields) {
                    members.length = 0;
                    break;
                }
            }
        } else if (members.length === 2) {
            // If one member is "()" proceed normally, else if one member has fields, remove it
            for (let i = members.length - 1; i >= 0; i--) {
                if (members[i].fields && context.isUnion) {
                    members.length = 0;
                    break;
                }
            }
        }
    }

    private determineIfUnion(members: FormField[], context: VisitorContext): void {
        if (members.length > 2) {
            context.isUnion = members.some((member) => member.typeName === "()");
        } else if (members.length === 2) {
            context.isUnion = !members.some(member => member.typeName === "()" || member.typeName === "readonly");
        } else {
            context.isUnion = false;
        }
    }

    private getResolvedTypeName(typeName: string, memberTypeNames: string[]): string {
        if (typeName === UnionEnumIntersectionType.INTERSECTION) {
            return `${memberTypeNames.join("&")}`;
        } else {
            return `${memberTypeNames.join("|")}`;
        }
    }

    private buildFieldMetadata(field: FormField, resolvedTypeName: string, context: VisitorContext): void {
        context.fieldMetadata = {
            optional: field.optional,
            typeName: resolvedTypeName,
            type: context.isArray
                ? (context.isArrayNullable
                    ? `${field.typeName}[]|()` : `${field.typeName}[]`)
                : field.typeName,
            typeInstance: field.name,
            ...(Object.keys(context.memberFieldsMetadata).length > 0 && { members: context.memberFieldsMetadata })
        };

        this.applyNullabilityToFieldMetadata(context);
    }

    private buildArrayFieldMetadata(field: FormField, resolvedTypeName: string, context: VisitorContext): void {
        context.fieldMetadata = {
            optional: field.optional,
            typeName: `(${resolvedTypeName})[]`,
            type: `${field.memberType.typeName}[]`,
            typeInstance: field.name,
            ...(Object.keys(context.memberFieldsMetadata).length > 0 && { members: context.memberFieldsMetadata })
        };

        this.applyNullabilityToFieldMetadata(context);
        const fieldName = getBalRecFieldName(field.name);
        context.recordFieldsMetadata[fieldName] = context.fieldMetadata as FieldMetadata;
    }

    private applyNullabilityToFieldMetadata(context: VisitorContext): void {
        // Apply nullableArray property
        if (context.isArray) {
            if (context.isRecord) {
                context.fieldMetadata.nullableArray = context.isRecordNullable;
            } else {
                context.fieldMetadata.nullableArray = context.isNullable;
            }
        }

        // Apply nullable property
        if (context.isArray) {
            context.fieldMetadata.nullable = context.isArrayNullable;
        } else if (context.isRecord) {
            context.fieldMetadata.nullable = context.isRecordNullable;
        } else if (context.isSimple) {
            context.fieldMetadata.nullable = context.isNullable;
        }
    }

    private setFieldAndMetadata(field: FormField, resolvedTypeName: string, context: VisitorContext): void {
        const fieldName = getBalRecFieldName(field.name);
        context.recordFields[fieldName] = Object.keys(context.memberRecordFields).length > 0
            ? context.memberRecordFields
            : { type: resolvedTypeName, comment: "" };
        context.recordFieldsMetadata[fieldName] = context.fieldMetadata as FieldMetadata;
    }

    private resetContext(context: VisitorContext): void {
        context.memberRecordFields = {};
        context.memberFieldsMetadata = {};
        context.fieldMetadata = {} as FieldMetadata;
        context.isArrayNullable = false;
        context.isRecordNullable = false;
        context.isNullable = false;
        context.isArray = false;
        context.isRecord = false;
        context.isSimple = false;
        context.isUnion = false;
    }
}

export function getBalRecFieldName(fieldName: string) {
    return keywords.includes(fieldName) ? `'${fieldName}` : fieldName;
}

export function isErrorCode(error: any): boolean {
    return error.hasOwnProperty("code") && error.hasOwnProperty("message");
}

export async function constructRecord(codeObject: { [key: string]: string }): Promise<{ recordString: string; isCheckError: boolean; }> {
    let recordString: string = "";
    let isCheckError: boolean = false;
    let objectKeys = Object.keys(codeObject);
    for (let index = 0; index < objectKeys.length; index++) {
        let key = objectKeys[index];
        let mapping = codeObject[key];
        if (typeof mapping === "string") {
            if (mapping.includes("check ")) {
                isCheckError = true;
            }
            if (recordString !== "") {
                recordString += ",\n";
            }
            recordString += `${key}:${mapping}`;
        } else {
            let subRecordResult = await constructRecord(mapping);
            if (subRecordResult.isCheckError) {
                isCheckError = true;
            }
            if (recordString !== "") {
                recordString += ",\n";
            }
            recordString += `${key}:${subRecordResult.recordString}`;
        }
    }
    return { recordString: `{\n${recordString}}`, isCheckError };
}

async function extractKeys(
    key: string,
    parameterDefinitions: ParameterMetadata
): Promise<ProcessParentKeyResult> {
    let innerKey: string = "";

    // Handle the key for nullable and optional fields
    key = key.replace(/\?*$/, "");

    // Check for a nested mapping like 'from var ... in ...'
    const nestedMappingMatch = key.match(/from\s+var\s+(\w+)\s+in\s+([\w?.]+)/);
    if (nestedMappingMatch) {
        innerKey = nestedMappingMatch[2];

        const keys = innerKey.split(".");
    } else if (key.startsWith("{") && key.endsWith("}")) {
        // Handle complex nested mappings in braces
        const matches = key.match(/\{\s*([^}]+)\s*\}/);
        innerKey = matches ? matches[1] : key;

        // Use regex to find each deeply nested mapping within braces
        const nestedKeys = innerKey.match(/[\w\s]+:\s*([\w?.]+)/g);
        if (nestedKeys) {
            const parsedKeys = nestedKeys.map(kv => kv.split(":")[1].trim());
            innerKey = parsedKeys[0] || ""; // Assume the first entry for simplicity if multiple mappings
        } else {
            // Fallback for simpler cases
            innerKey = innerKey.split(",").map(kv => kv.split(":")[1].trim())[0] || "";
        }
    } else {
        // Standard case
        innerKey = key.match(/\(([^)]+)\)/)?.[1] || key;

        innerKey = innerKey
            .replace(/^check\s*/, '')
            .replace(/\.ensureType\(\)$/, '')
            .replace(/\.toString\(\)$/, '');
    }
    // Call the helper function to process parent keys
    const processedKeys = await processParentKey(innerKey, parameterDefinitions);
    return {
        itemKey: processedKeys.itemKey,
        combinedKey: processedKeys.combinedKey,
        inputArrayNullable: processedKeys.inputArrayNullable
    };
}

function refineKey(key: string): string {
    return key
        .replace(/\?\./g, ".") // Replace `?.` with `.`
        .replace(/\?$/g, "") // Remove a trailing `?`
        .replace(/\s*\?:.*$/g, "") // Remove `?: <value>`
        .replace(/[\(\)]/g, ""); // Remove parentheses
}

async function processParentKey(
    innerKey: string,
    parameterDefinitions: ParameterMetadata
): Promise<ProcessParentKeyResult> {
    let itemKey: string = "";
    let combinedKey: string = "";
    let isSet: boolean = false;
    let inputArrayNullable: boolean = false;

    // Split the innerKey to get parent keys and field name
    let keys = innerKey.split(".");
    let fieldName = keys.pop()!;
    let parentKey = keys.slice(0, keys.length);

    const refinedInnerKey = refineKey(innerKey);
    const refinedKeys = refinedInnerKey.split(".");
    const refinedParentKey = refinedKeys.slice(0, keys.length);

    // Handle the base case where there's only one key
    if (refinedParentKey.length === 1) {
        return {
            itemKey: parentKey[0],
            combinedKey: parentKey[0],
            inputArrayNullable: false
        };
    }

    for (let index = refinedParentKey.length - 1; index > 0; index--) {
        const modifiedInputs = await getMetadata(parameterDefinitions, refinedParentKey, refinedParentKey[index], MetadataType.INPUT_METADATA);
        inputArrayNullable = modifiedInputs.nullableArray;

        if (!isSet && (isArrayEnumUnion(modifiedInputs.type) || isArrayRecord(modifiedInputs.typeName))) {
            itemKey = parentKey[index];
            combinedKey = parentKey.slice(0, index + 1).join(".");
            isSet = true;
        }
    }
    return { itemKey, combinedKey, inputArrayNullable };
}

async function processCombinedKey(
    combinedKey: string,
    parameterDefinitions: ParameterMetadata
): Promise<ProcessCombinedKeyResult> {
    let isinputRecordArrayNullable: boolean = false;
    let isinputRecordArrayOptional: boolean = false;
    let isinputArrayNullable: boolean = false;
    let isinputArrayOptional: boolean = false;
    let isSet: boolean = false;
    let isinputNullableArray: boolean = false;

    const refinedCombinedKey = refineKey(combinedKey);
    const refinedCombinedKeys = refinedCombinedKey.split(".");
    const lastIndex = refinedCombinedKeys.length - 1;

    const modifiedInputs = await getMetadata(parameterDefinitions, refinedCombinedKeys, refinedCombinedKeys[lastIndex], MetadataType.INPUT_METADATA);

    if (!isSet && (isArrayRecord(modifiedInputs.typeName) || isArrayEnumUnion(modifiedInputs.type))) {
        isSet = true;
    }

    if (isSet) {
        // Update record array flags
        if (modifiedInputs.nullable) { isinputRecordArrayNullable = true; }
        if (modifiedInputs.optional) { isinputRecordArrayOptional = true; }

        // Check preceding elements for non-`record[]` types
        for (let nextIndex = lastIndex - 1; nextIndex >= 0; nextIndex--) {
            isinputNullableArray = false;
            const nextModifiedInputs = await getMetadata(parameterDefinitions, refinedCombinedKeys, refinedCombinedKeys[nextIndex], MetadataType.INPUT_METADATA);

            if (!(isArrayRecord(nextModifiedInputs.typeName) || isArrayEnumUnion(nextModifiedInputs.type))) {
                if (nextModifiedInputs.nullable) { isinputArrayNullable = true; }
                if (nextModifiedInputs.optional) { isinputArrayOptional = true; }
            } else {
                if (isArrayRecord(nextModifiedInputs.typeName) || isArrayEnumUnion(nextModifiedInputs.type)) {
                    if (nextModifiedInputs.nullableArray && (nextIndex === (lastIndex - 1))) { isinputNullableArray = true; }
                }
                return {
                    isinputRecordArrayNullable,
                    isinputRecordArrayOptional,
                    isinputArrayNullable,
                    isinputArrayOptional,
                    isinputNullableArray
                };
            }
        }
    }
    return {
        isinputRecordArrayNullable,
        isinputRecordArrayOptional,
        isinputArrayNullable,
        isinputArrayOptional,
        isinputNullableArray
    };
}

async function sendMappingFileUploadRequest(file: Blob): Promise<Response | ErrorCode> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetchWithToken(CONTEXT_UPLOAD_URL_V1 + "/file_upload/generate_mapping_instruction", {
        method: "POST",
        body: formData
    });
    return response;
}

export async function getMappingFromFile(file: Blob): Promise<MappingFileRecord | ErrorCode> {
    try {
        let response = await sendMappingFileUploadRequest(file);
        if (isErrorCode(response)) {
            return response as ErrorCode;
        }
        response = response as Response;
        let mappingContent = JSON.parse((await filterMappingResponse(response)) as string);
        if (isErrorCode(mappingContent)) {
            return mappingContent as ErrorCode;
        }
        return mappingContent;
    } catch (error) {
        console.error(error);
        return TIMEOUT;
    }
}

export async function mappingFileParameterDefinitions(file: Attachment, parameterDefinitions: ParameterMetadata): Promise<ParameterMetadata | ErrorCode> {
    if (!file) { return parameterDefinitions; }

    const convertedFile = convertBase64ToBlob(file);
    if (!convertedFile) { throw new Error("Invalid file content"); }

    let mappingFile = await getMappingFromFile(convertedFile);
    if (isErrorCode(mappingFile)) { return mappingFile as ErrorCode; }

    mappingFile = mappingFile as MappingFileRecord;

    return {
        ...parameterDefinitions,
        mapping_fields: mappingFile.mapping_fields,
    };
}

async function sendDatamapperRequest(parameterDefinitions: ParameterMetadata, accessToken: string): Promise<Response | ErrorCode> {
    const response = await fetchWithTimeout(BACKEND_URL + "/datamapper", {
        method: "POST",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Ballerina-VSCode-Plugin',
            'Authorization': 'Bearer ' + accessToken
        },
        body: JSON.stringify(parameterDefinitions)
    }, REQUEST_TIMEOUT);

    return response;
}

function isMappingData(obj: MappingData | IntermediateMapping): obj is MappingData {
    return (
        typeof obj === "object" &&
        obj !== null &&
        typeof obj.operation === "string" &&
        Array.isArray(obj.parameters) &&
        typeof obj.targetType === "string"
    );
}

async function resolveMetadata(parameterDefinitions: ParameterMetadata, nestedKeyArray: string[], key: string, metadataKey: MetadataType.INPUT_METADATA | MetadataType.OUTPUT_METADATA): Promise<ParameterField | FieldMetadata> {
    let metadata = parameterDefinitions[metadataKey];
    for (let nk of nestedKeyArray) {
        if (metadata[nk] && (metadata[nk].fields || metadata[nk].members)) {
            if (nk === key) {
                return metadata[nk];
            }
            metadata = metadata[nk].fields || metadata[nk].members;
        } else {
            return metadata[key];
        }
    }
    return metadata[key];
}

async function getNestedType(paths: string[], metadata: ParameterField | FieldMetadata): Promise<FieldMetadata> {
    for (let i = 0; i < paths.length; i++) {
        let cleanPath = paths[i].replace(/\?.*$/, "");
        if (metadata.fields && metadata.fields[cleanPath]) {
            metadata = metadata.fields[cleanPath];
        } else if (metadata.members && metadata.members[cleanPath]) {
            metadata = metadata.members[cleanPath];
        } else {
            throw new Error(`Field ${cleanPath} not found in metadata.`);
        }
    }
    return metadata as FieldMetadata;
}

async function getMetadata(
    parameterDefinitions: ParameterMetadata,
    refinedParentKey: string[],
    key: string,
    metadataType: MetadataType
): Promise<FieldMetadata> {
    const metadata = await resolveMetadata(parameterDefinitions, refinedParentKey, key, metadataType) as FieldMetadata;
    if (!metadata) {
        throw new Error(`Metadata not found for key: "${key}" in ${metadataType}.`);
    }
    return metadata;
}

async function accessMetadata(
    paths: string[],
    parameterDefinitions: ParameterMetadata,
    outputObject: FieldMetadata,
    baseType: string,
    baseTargetType: string,
    operation: string
): Promise<string[]> {
    let newPath: string[] = [...paths];
    let isUsingDefault = false;
    let isUsingArray = false;
    let defaultValue: string;
    let modifiedBaseType: string;

    baseTargetType = outputObject.typeName.replace(/\|\(\)$/, "");

    // Process paths for metadata
    for (let index = 1; index < paths.length; index++) {
        const pathIndex = paths[index];
        let inputObject = await getMetadata(parameterDefinitions, paths, pathIndex, MetadataType.INPUT_METADATA);

        if (inputObject.hasOwnProperty("members") || inputObject.hasOwnProperty("fields") || operation === Operation.LENGTH) {
            if (!["enum", "enum|()"].includes(inputObject.type)) {
                isUsingDefault = false;
            }

            if (isArrayRecord(inputObject.typeName) || isArrayEnumUnion(inputObject.type)) {
                if (inputObject.nullableArray) {
                    isUsingArray = true;
                } else {
                    isUsingArray = false;
                }
            }
            if (isUsingArray && isRecordType(inputObject.typeName)) {
                newPath[index] = `${paths[index]}?`;
            }
            if (inputObject.nullable || inputObject.optional) {
                // Handle record types
                if (isRecordType(inputObject.typeName)) {
                    if (!inputObject.typeName.includes("[]")) {
                        if (index !== (paths.length - 1)) {
                            newPath[index] = `${paths[index]}?`;
                            isUsingDefault = true;
                        }
                    }
                    if (inputObject.typeName.includes("[]") && operation === Operation.LENGTH) {
                        let lastInputObject = await getMetadata(parameterDefinitions, paths, paths[paths.length - 1], MetadataType.INPUT_METADATA);
                        let inputDataType = lastInputObject.typeName.replace(/\|\(\)$/, "");
                        defaultValue = await getDefaultValue(inputDataType);
                        newPath[paths.length - 1] = `${paths[paths.length - 1]}?:${defaultValue}`;
                    }
                    if (inputObject.nullable && inputObject.optional) {
                        newPath[index - 1] = `${paths[index - 1]}?`;
                    }
                    // Handle enum, union, and intersection types    
                } else if (isUnionEnumIntersectionType(inputObject.type)) {
                    if (inputObject.nullable && inputObject.optional) {
                        newPath[index - 1] = `${paths[index - 1]}?`;
                    }
                    if (inputObject.type.includes("[]") && operation === Operation.LENGTH) {
                        let lastInputObject = await getMetadata(parameterDefinitions, paths, paths[paths.length - 1], MetadataType.INPUT_METADATA);
                        let inputDataType = lastInputObject.type.replace(/\|\(\)$/, "");
                        defaultValue = await getDefaultValue(inputDataType);
                        newPath[paths.length - 1] = `${paths[paths.length - 1]}?:${defaultValue}`;
                    } else if (!outputObject.nullable && !outputObject.optional) {
                        if (isUnionEnumIntersectionType(inputObject.type) && inputObject.members) {
                            if (!inputObject.nullableArray || outputObject.nullableArray) {
                                let typeName = inputObject.type.includes("[]")
                                    ? inputObject.type.replace(/\|\(\)$/, "")
                                    : inputObject.members[Object.keys(inputObject.members)[0]].typeName;

                                let defaultValue = await getDefaultValue(typeName);
                                newPath[paths.length - 1] = `${paths[paths.length - 1]}?:${defaultValue !== "void" ? defaultValue : JSON.stringify(typeName)}`;
                            }
                        }
                        return newPath;
                    }
                }
            } else {
                if (isUsingDefault && isUnionEnumIntersectionType(inputObject.type) && inputObject.members) {
                    if (!outputObject.nullable && !outputObject.optional) {
                        let typeName = inputObject.type.includes("[]")
                            ? inputObject.type.replace("|()", "")
                            : inputObject.members[Object.keys(inputObject.members)[0]].typeName;

                        let defaultValue = await getDefaultValue(typeName);
                        newPath[paths.length - 1] = `${paths[paths.length - 1]}?:${defaultValue !== "void" ? defaultValue : JSON.stringify(typeName)}`;
                    }
                }
            }
        } else {
            if (inputObject.nullable && inputObject.optional) {
                newPath[index - 1] = `${paths[index - 1]}?`;
            }
            if (!isPrimitiveType(baseType)) {
                if (baseType.includes("[]")) {
                    if (!inputObject.nullableArray || outputObject.nullableArray) {
                        defaultValue = `[]`;
                    }
                } else {
                    let cleanedBaseType = baseType.replace(/[\[\]()]*/g, "");
                    modifiedBaseType = cleanedBaseType.includes("|")
                        ? cleanedBaseType.split("|")[0].trim()
                        : cleanedBaseType;
                    defaultValue = await getDefaultValue(modifiedBaseType);
                }
            } else {
                defaultValue = await getDefaultValue(baseType);
            }

            if (isUsingArray) {
                newPath[index] = `${pathIndex}?:${defaultValue}`;
            }

            if (isUsingDefault && !outputObject.nullable && !outputObject.optional) {
                newPath[index] = `${pathIndex}?:${defaultValue}`;
                return newPath;
            }
            if (!inputObject.nullable && !inputObject.optional) {
                return newPath;
            }
            if (!outputObject.nullable && !outputObject.optional) {
                if (!inputObject.nullableArray && outputObject.nullableArray) {
                    newPath[index] = `${pathIndex}?:${defaultValue}`;
                    return newPath;
                }
                newPath[index] = baseType === "string" || baseType === baseTargetType
                    ? `${pathIndex}?:${defaultValue}`
                    : `${pathIndex}`;
                return newPath;
            }
            newPath[index] = baseType !== baseTargetType && baseType === "string"
                ? `${pathIndex}?:${defaultValue}`
                : `${pathIndex}`;
            return newPath;
        }
    }
    return newPath;
}

async function getDefaultValue(dataType: string): Promise<string> {
    switch (dataType) {
        case "string":
            return "\"\"";
        case "int":
            return "0";
        case "decimal":
            return "0.0";
        case "float":
            return "0.0";
        case "boolean":
            return "false";
        case "json":
            return "()";
        case "int[]":
        case "string[]":
        case "float[]":
        case "decimal[]":
        case "boolean[]":
        case "record[]":
        case "(readonly&record)[]":
        case "enum[]":
        case "union[]":
        case "intersection[]":
        case "json[]":
            return "[]";
        default:
            // change the following to a appropriate value
            return "void";
    }
}

async function getMappingString(mapping: MappingData, parameterDefinitions: ParameterMetadata, nestedKey: string, nestedKeyArray: string[]): Promise<string | ErrorCode> {
    let operation: string = mapping.operation;
    let targetType: string = mapping.targetType;
    let parameters: string[] = mapping.parameters;

    let path: string = "";
    let modifiedPaths: string[] = [];
    let inputTypeName: string = "";
    let inputType: string = "";
    let baseType: string = "";
    let baseTargetType: string = "";
    let outputType: string = "";
    let baseOutputType: string = "";
    let baseInputType: string = "";
    let modifiedInput: FieldMetadata;
    let outputObject: FieldMetadata;
    let isInputNullableArray: boolean;
    let isOutputNullableArray: boolean;

    let paths = parameters[0].split(".");
    let recordObjectName: string = paths[0];

    // Retrieve inputType
    if (paths.length > 2) {
        modifiedInput = await getNestedType(paths.slice(1), parameterDefinitions.inputMetadata[recordObjectName]);
    } else if (paths.length === 2) {
        modifiedInput = parameterDefinitions.inputMetadata[recordObjectName].fields[paths[1]];
    } else {
        modifiedInput = parameterDefinitions.configurables[recordObjectName] ||
            parameterDefinitions.constants[recordObjectName] ||
            parameterDefinitions.variables[recordObjectName] || parameterDefinitions.inputMetadata[recordObjectName].fields[paths[0]];
    }

    // Resolve output metadata
    if (nestedKeyArray.length > 0) {
        outputObject = await getMetadata(parameterDefinitions, nestedKeyArray, nestedKey, MetadataType.OUTPUT_METADATA);
    } else if (parameterDefinitions.outputMetadata.hasOwnProperty("fields") || !parameterDefinitions.outputMetadata[nestedKey]) {
        throw new Error(`Invalid or missing metadata for nestedKey: ${nestedKey}.`);
    } else {
        outputObject = parameterDefinitions.outputMetadata[nestedKey];
    }

    baseTargetType = targetType.replace(/\|\(\)$/, "");

    inputTypeName = modifiedInput.typeName;
    baseType = inputTypeName.replace(/\|\(\)$/, "");

    inputType = modifiedInput.type;
    baseInputType = inputType.replace(/\|\(\)$/, "");

    outputType = outputObject.type;
    baseOutputType = outputType.replace(/\|\(\)$/, "");

    if (operation === Operation.DIRECT) {
        if (parameters.length > 1) {
            return "";
        }
        const hasArrayNotation = (type: string) => type.includes("[]");
        if (isRecordType(baseType)) {
            if (!(hasArrayNotation(baseType) === hasArrayNotation(baseTargetType)) && !(baseTargetType === "int")) {
                return "";
            }
        } else if (isUnionEnumIntersectionType(baseOutputType)) {
            if (!(hasArrayNotation(baseInputType) === hasArrayNotation(baseOutputType))) {
                return "";
            }
        }
        modifiedPaths = await accessMetadata(
            paths,
            parameterDefinitions,
            outputObject,
            baseType,
            baseTargetType,
            operation
        );
        for (let index = 0; index < modifiedPaths.length; index++) {
            if (index > 0 && modifiedPaths[index] === modifiedPaths[index - 1]) {
                continue;
            }
            if (path !== "") {
                path = `${path}.`;
            }
            path = `${path}${modifiedPaths[index]}`;
        }
        // Add split operation if inputType is "string" and targetType is "string[]"
        if (baseType === PrimitiveType.STRING && baseTargetType === "string[]") {
            return `re \`,\`.split(${path})`;
        }

        // Add length operation if inputType is "record[]" and targetType is "int"
        if (isArrayRecord(baseType) && baseTargetType === "int") {
            return `(${path}).length()`;
        }

        // Type conversion logic
        const stringConversions: { [key: string]: string } = {
            int: "check int:fromString",
            float: "check float:fromString",
            decimal: "check decimal:fromString",
            boolean: "check boolean:fromString"
        };

        const numericConversions: { [key: string]: { [key: string]: string } } = {
            float: {
                int: `check (${path}).ensureType()`,
                decimal: `check (${path}).ensureType()`
            },
            int: {
                float: `check (${path}).ensureType()`,
                decimal: `check (${path}).ensureType()`
            },
            decimal: {
                int: `check (${path}).ensureType()`,
                float: `check (${path}).ensureType()`
            }
        };

        function convertUnionTypes(inputType: string, targetType: string, variablePath: string) {
            const inputTypes = inputType.split("|").filter(type => isPrimitiveType(type));

            if (targetType === PrimitiveType.STRING) {
                return `(${variablePath}).toString()`;
            }

            if (inputTypes.includes(PrimitiveType.STRING) &&
                [PrimitiveType.INT, PrimitiveType.FLOAT, PrimitiveType.DECIMAL, PrimitiveType.BOOLEAN].includes(targetType as PrimitiveType)) {
                return `(${variablePath}) is string ? check ${targetType}:fromString((${variablePath}).toString()) : check (${variablePath}).ensureType()`;
            }

            if ([PrimitiveType.INT, PrimitiveType.FLOAT, PrimitiveType.DECIMAL, PrimitiveType.BOOLEAN].includes(targetType as PrimitiveType)) {
                return `check (${variablePath}).ensureType()`;
            }

            return `${variablePath}`;
        }

        isOutputNullableArray = outputObject.nullableArray;
        isInputNullableArray = modifiedInput.nullableArray;

        const isStringInput = ["string", "string|()"].includes(inputTypeName);
        const isStringTarget = ["string", "string|()"].includes(targetType);
        if (isPrimitiveType(baseTargetType) && isPrimitiveType(baseType)) {
            if (inputTypeName === targetType || inputTypeName === baseTargetType) {
                path = `${path}`;
            } else if (isStringInput) {
                const conversion = stringConversions[baseTargetType];
                if (conversion) {
                    path = `${conversion}(${path})`;
                } else if (!isStringTarget) {
                    return "";
                }
            } else if (isStringTarget) {
                path = `(${path}).toString()`;
            } else {
                const conversion = numericConversions[inputTypeName]?.[targetType];
                if (conversion && baseTargetType !== PrimitiveType.BOOLEAN) {
                    path = conversion;
                } else if (baseType === baseTargetType) {
                    path = `${path}`;
                } else if ((targetType.includes("|()") && inputTypeName !== baseTargetType) || inputTypeName.includes("|()") && baseTargetType !== "boolean") {
                    path = `check (${path}).ensureType()`;
                } else {
                    return "";
                }
            }
        } else if (isUnionEnumIntersectionType(inputType)) {
            if (isUnionType(baseType)) {
                path = convertUnionTypes(baseType, baseTargetType, path);
            } else {
                path = `${path}`;
                if (isInputNullableArray && !isOutputNullableArray) {
                    path = `check (${path}).cloneWithType()`;
                }
            }
        }
    } else if (operation === Operation.LENGTH) {
        if (parameters.length > 1) {
            return "";
        }
        modifiedPaths = await accessMetadata(
            paths,
            parameterDefinitions,
            outputObject,
            baseType,
            baseTargetType,
            operation
        );
        for (let index = 0; index < modifiedPaths.length; index++) {
            if (path !== "") {
                path = `${path}.`;
            }
            path = `${path}${modifiedPaths[index]}`;
        }
        path = `(${path}).length()`;
    } else if (operation === Operation.SPLIT) {
        if (parameters.length > 2) {
            return "";
        }
        modifiedPaths = await accessMetadata(
            paths,
            parameterDefinitions,
            outputObject,
            baseType,
            baseTargetType,
            operation
        );
        for (let index = 0; index < modifiedPaths.length; index++) {
            if (path !== "") {
                path = `${path}.`;
            }
            path = `${path}${modifiedPaths[index]}`;
        }
        path = `re \`${parameters[1]}\`.split(${path})`;
    }
    return path;
}

async function processMappingData(
    mappingData: MappingData,
    parameterDefinitions: ParameterMetadata,
    nestedKey: string,
    nestedKeyArray: string[]
): Promise<{ [key: string]: string }> {
    const parameters = mappingData.parameters;
    const paths = parameters[0].split(".");

    const path = await getMappingString(
        mappingData,
        parameterDefinitions,
        nestedKey,
        nestedKeyArray
    );

    if (typeof path !== "string" || path === "" || isErrorCode(path)) {
        return {};
    }

    const recordFieldName =
        paths.length === 1 ? nestedKey : (nestedKey || paths[1]);

    return { [recordFieldName]: path };
}


export async function filterResponse(resp: Response): Promise<IntermediateMapping | ErrorCode> {
    if (resp.status == 200 || resp.status == 201) {
        const data = (await resp.json()) as MappingsResponse;
        console.log(JSON.stringify(data.mappings));
        return data.mappings;
    }
    if (resp.status == 404) {
        return ENDPOINT_REMOVED;
    }
    if (resp.status == 400) {
        const data = (await resp.json()) as any;
        console.log(data);
        return PARSING_ERROR;
    }
    if (resp.status == 429) {
        return TOO_MANY_REQUESTS;
    }
    if (resp.status == 500) {
        return SERVER_ERROR;
    } else {
        //TODO: Handle more error codes
        return TIMEOUT;
    }
}

export async function generateBallerinaCode(
    response: IntermediateMapping,
    parameterDefinitions: ParameterMetadata,
    nestedKey: string = "",
    nestedKeyArray: string[]
): Promise<{ [key: string]: string } | ErrorCode> {
    let recordFields: { [key: string]: string } = {};

    if (isMappingData(response)) {
        return await processMappingData(
            response,
            parameterDefinitions,
            nestedKey,
            nestedKeyArray
        );
    }

    const objectKeys = Object.keys(response);
    for (const key of objectKeys) {
        const subRecord = response[key];
        if (isMappingData(subRecord)) {
            const nestedResponseRecord = await processMappingData(
                subRecord,
                parameterDefinitions,
                key,
                nestedKeyArray
            );
            Object.assign(recordFields, nestedResponseRecord);
        } else {
            nestedKeyArray.push(key);
            const responseRecord = await generateBallerinaCode(
                subRecord as IntermediateMapping,
                parameterDefinitions,
                key,
                nestedKeyArray
            );
            if (isErrorCode(responseRecord)) {
                nestedKeyArray.pop();
                return responseRecord;
            }
            const recordFieldDetails = await handleRecordArrays(
                key,
                nestedKey,
                responseRecord as { [key: string]: string },
                parameterDefinitions,
                nestedKeyArray
            );
            nestedKeyArray.pop();
            Object.assign(recordFields, recordFieldDetails);
        }
    }
    return recordFields;
}

export async function getDatamapperCode(parameterDefinitions: ParameterMetadata): Promise<{ [key: string]: string } | ErrorCode> {
    let nestedKeyArray: string[] = [];
    try {
        const accessToken = await getAccessToken().catch((error) => {
            console.error(error);
            return NOT_LOGGED_IN;
        });
        let response = await sendDatamapperRequest(parameterDefinitions, accessToken as string);
        if (isErrorCode(response)) {
            return (response as ErrorCode);
        }

        response = (response as Response);

        // Refresh
        if (response.status === 401) {
            const newAccessToken = await getRefreshedAccessToken();
            if (!newAccessToken) {
                AIStateMachine.service().send(AIMachineEventType.LOGOUT);
                return;
            }
            let retryResponse: Response | ErrorCode = await sendDatamapperRequest(parameterDefinitions, newAccessToken);

            if (isErrorCode(retryResponse)) {
                return (retryResponse as ErrorCode);
            }

            retryResponse = (retryResponse as Response);
            let intermediateMapping = await filterResponse(retryResponse);
            if (isErrorCode(intermediateMapping)) {
                return (intermediateMapping as ErrorCode);
            }
            let finalCode = await generateBallerinaCode(intermediateMapping as IntermediateMapping, parameterDefinitions, "", nestedKeyArray);
            return finalCode;
        }
        let intermediateMapping = await filterResponse(response);
        if (isErrorCode(intermediateMapping)) {
            return (intermediateMapping as ErrorCode);
        }
        let finalCode = await generateBallerinaCode(intermediateMapping as IntermediateMapping, parameterDefinitions, "", nestedKeyArray);
        return finalCode;
    } catch (error) {
        console.error(error);
        return TIMEOUT;
    }
}

// Function to check if a given type is a valid union type (order-independent)
function isUnionType(type: string): boolean {
    const sortedType = type.split("|").sort().join("|"); 
    const validUnionTypes = getUnionTypes(Object.values(PrimitiveType));
    return validUnionTypes.includes(sortedType); 
}

// Get union types from the combination of union types
function getUnionTypes(types: string[]) {
    const result = new Set<string>(); 
    const len = types.length;
    for (let i = 2; i <= len; i++) {
        generateCombinations(types, i, 0, [], result);
    }

    return Array.from(result);
}

// Generate union combination
function generateCombinations(arr: string[], size: number, start: number, current: string[], result: Set<string>) {
    if (current.length === size) {
        result.add(current.slice().sort().join("|"));
        return;
    }
    for (let i = start; i < arr.length; i++) {
        generateCombinations(arr, size, i + 1, [...current, arr[i]], result);
    }
}

async function handleRecordArrays(key: string, nestedKey: string, responseRecord: { [key: string]: string }, parameterDefinitions: ParameterMetadata, nestedKeyArray: string[]) {
    let recordFields: { [key: string]: string } = {};
    let subObjectKeys = Object.keys(responseRecord);

    let formattedRecordsArray: string[] = [];
    let itemKey: string = "";
    let combinedKey: string = "";
    let modifiedOutput: FieldMetadata;
    let outputMetadataType: string = "";
    let outputMetadataTypeName: string = "";

    for (let subObjectKey of subObjectKeys) {
        if (!nestedKey) {
            modifiedOutput = parameterDefinitions.outputMetadata[key];
        } else {
            modifiedOutput = await getMetadata(parameterDefinitions, nestedKeyArray, key, MetadataType.OUTPUT_METADATA);
        }
        outputMetadataTypeName = modifiedOutput.typeName;
        outputMetadataType = modifiedOutput.type;
        let isDeeplyNested = (isArrayRecord(outputMetadataTypeName) || isArrayEnumUnion(outputMetadataType));

        let { itemKey: currentItemKey, combinedKey: currentCombinedKey, inputArrayNullable: currentArrayNullable } = await extractKeys(responseRecord[subObjectKey], parameterDefinitions);
        if (currentItemKey.includes('?')) {
            currentItemKey = currentItemKey.replace('?', '');
        }
        if (modifiedOutput.hasOwnProperty("fields") || modifiedOutput.hasOwnProperty("members")) {
            if (isDeeplyNested) {
                const subArrayRecord = responseRecord[subObjectKey];
                const isCombinedKeyModified = currentCombinedKey.endsWith('?');
                const replacementKey = currentArrayNullable || isCombinedKeyModified
                    ? `${currentItemKey}Item?.`
                    : `${currentItemKey}Item.`;

                const regex = new RegExp(
                    currentCombinedKey.replace(/\?/g, '\\?').replace(/\./g, '\\.') + '\\.', 'g'
                );

                formattedRecordsArray.push(
                    `${subObjectKey}: ${subArrayRecord.replace(regex, replacementKey)}`
                );

                itemKey = currentItemKey;
                combinedKey = currentCombinedKey;
            } else {
                formattedRecordsArray.push(`${subObjectKey}: ${responseRecord[subObjectKey]}`);
            }
        } else {
            recordFields = { ...recordFields, [key]: JSON.stringify(responseRecord) };
        }
    }

    if (formattedRecordsArray.length > 0 && itemKey && combinedKey) {
        const formattedRecords = formattedRecordsArray.join(",\n");
        const keyToReplace = combinedKey.endsWith('?') ? combinedKey.replace(/\?$/, '') : combinedKey;
        const processedKeys = await processCombinedKey(combinedKey, parameterDefinitions);
        const combinedKeyExpression = (processedKeys.isinputRecordArrayNullable || processedKeys.isinputRecordArrayOptional || processedKeys.isinputArrayNullable || processedKeys.isinputArrayOptional || processedKeys.isinputNullableArray)
            ? `${keyToReplace} ?: []`
            : keyToReplace;
        recordFields[key] = `from var ${itemKey}Item in ${combinedKeyExpression}\n select {\n ${formattedRecords}\n}`;
    } else {
        recordFields[key] = `{\n ${formattedRecordsArray.join(",\n")} \n}`;
    }

    return { ...recordFields };
}

// TypeCreator Relatated Logic
export async function typesFileParameterDefinitions(file: Attachment): Promise<string | ErrorCode> {
    if (!file) { throw new Error("File is undefined"); }

    const convertedFile = convertBase64ToBlob(file);
    if (!convertedFile) { throw new Error("Invalid file content"); }

    let typesFile = await getTypesFromFile(convertedFile);
    if (isErrorCode(typesFile)) { return typesFile as ErrorCode; }

    return typesFile;
}

export async function getTypesFromFile(file: Blob): Promise<string | ErrorCode> {
    try {
        let response = await sendTypesFileUploadRequest(file);
        if (isErrorCode(response)) {
            return response as ErrorCode;
        }
        response = response as Response;
        let typesContent = await filterMappingResponse(response) as string;
        return typesContent;
    } catch (error) {
        console.error(error);
        return TIMEOUT;
    }
}

async function sendTypesFileUploadRequest(file: Blob): Promise<Response | ErrorCode> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetchWithToken(CONTEXT_UPLOAD_URL_V1 + "/file_upload/generate_record", {
        method: "POST",
        body: formData
    });
    return response;
}

// InlineDatamapper Related Logic
export async function mappingFileInlineDataMapperModel(file: Attachment, inlineDataMapperResponse: InlineDataMapperModelResponse): Promise<InlineDataMapperModelResponse | ErrorCode> {
    if (!file) { return inlineDataMapperResponse; }

    const convertedFile = convertBase64ToBlob(file);
    if (!convertedFile) { throw new Error("Invalid file content"); }

    let mappingFile = await getMappingFromFile(convertedFile);
    if (isErrorCode(mappingFile)) { return mappingFile as ErrorCode; }

    mappingFile = mappingFile as MappingFileRecord;

    return {
        ...(inlineDataMapperResponse as InlineDataMapperModelResponse),
        mappingsModel: {
            ...(inlineDataMapperResponse as InlineDataMapperModelResponse).mappingsModel,
            mapping_fields: mappingFile.mapping_fields,
        }
    };
}

// Extract Requirements
export async function requirementsSpecification(filepath: string): Promise<string | ErrorCode> {
    if (!filepath) {
        throw new Error("File is undefined");
    }

    const convertedFile = convertBase64ToBlob({
        name: path.basename(filepath),
        content: getBase64FromFile(filepath), status: AttachmentStatus.UnknownError
    });
    if (!convertedFile) { throw new Error("Invalid file content"); }

    let requirements = await getTextFromRequirements(convertedFile);
    if (isErrorCode(requirements)) {
        return requirements as ErrorCode;
    }

    return requirements;
}

function getBase64FromFile(filePath: string) {
    const fileBuffer = fs.readFileSync(filePath);
    return fileBuffer.toString('base64');
}

export async function getTextFromRequirements(file: Blob): Promise<string | ErrorCode> {
    try {
        let response = await sendRequirementFileUploadRequest(file);
        if (isErrorCode(response)) {
            return response as ErrorCode;
        }
        response = response as Response;
        let requirements = await filterMappingResponse(response) as string;
        return requirements;
    } catch (error) {
        console.error(error);
        return UNKNOWN_ERROR;
    }
}

async function sendRequirementFileUploadRequest(file: Blob): Promise<Response | ErrorCode> {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetchWithToken(CONTEXT_UPLOAD_URL_V1 + "/file_upload/extract_requirements", {
        method: "POST",
        body: formData
    });
    return response;
}

// Ask Command Related Logic
export async function searchDocumentation(message: string): Promise<string> {
    const response = await fetchWithToken(ASK_API_URL_V1 + "/documentation-assistant", {
        method: "POST",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            "query": `${message}`
        })
    });
    return await filterDocumentation(response as Response);
}

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

// Exports 
export function cleanDiagnosticMessages(entries: DiagnosticEntry[]): DiagnosticEntry[] {
    return entries.map(entry => ({
        code: entry.code || "",
        message: entry.message,
    }));
}

export async function getFunction(modulePart: ModulePart, functionName: string) {
    const fns = modulePart.members.filter((mem) =>
        STKindChecker.isFunctionDefinition(mem)
    ) as FunctionDefinition[];

    return fns.find(mem => mem.functionName.value === functionName);
}
