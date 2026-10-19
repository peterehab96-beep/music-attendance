import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * حقل كلمة مرور مع ميزة «العين»: زر يظهر/يخفي النص.
 * تُستخدم في تسجيل الدخول (طالب/أدمن)، إنشاء الحساب، ولوحة الطالب
 * (إعادة التعيين + التغيير المباشر). العين تفتح لإظهار النص وتقفل لإخفائه.
 */
export function PasswordField({
  value,
  onChange,
  placeholder,
  autoComplete,
  minLength,
  required,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  children?: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="input-with-icon password-field">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        dir="ltr"
      />
      <button
        type="button"
        className="password-eye"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
        title={visible ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
        tabIndex={-1}
      >
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
      {children}
    </div>
  );
}
