import { 
  FileText, 
  FileSpreadsheet, 
  FileImage, 
  FileArchive, 
  File 
} from 'lucide-react';

interface FileTypeIconProps {
  mimeType: string;
  size?: number;
  className?: string;
}

export const FileTypeIcon = ({
  mimeType,
  size = 24,
  className = ''
}: FileTypeIconProps) => {
  if (mimeType.startsWith('image/')) {
    return <FileImage className={className} style={{ color: '#8b5cf6' }} size={size} />;
  }
  if (mimeType.includes('pdf')) {
    return <FileText className={className} style={{ color: '#dc2626' }} size={size} />;
  }
  if (mimeType.includes('sheet') || mimeType.includes('excel')) {
    return <FileSpreadsheet className={className} style={{ color: '#059669' }} size={size} />;
  }
  if (mimeType.includes('document') || mimeType.includes('word')) {
    return <FileText className={className} style={{ color: '#2563eb' }} size={size} />;
  }
  if (mimeType.includes('zip') || mimeType.includes('archive') || mimeType.includes('rar')) {
    return <FileArchive className={className} style={{ color: '#d97706' }} size={size} />;
  }
  return <File className={className} style={{ color: '#475569' }} size={size} />;
};
